import { ClientDuplexStream, ServiceError } from '@grpc/grpc-js';
import { InworldPacket as ProtoPacket } from '@proto/packets_pb';
import { ClientRequest, UserRequest } from '@proto/world-engine_pb';
import { clearTimeout } from 'timers';

import {
  ApiKey,
  Awaitable,
  ConnectionState,
  GenerateSessionTokenFn,
  GetterSetter,
  InternalClientConfiguration,
} from '../common/interfaces';
import { InworldPacket } from '../entities/inworld_packet.entity';
import { Scene } from '../entities/scene.entity';
import { Session } from '../entities/session.entity';
import { SessionToken } from '../entities/session_token.entity';
import { EventFactory } from '../factories/event';
import { TokenClientGrpcService } from './gprc/token_client_grpc.service';
import { WorldEngineClientGrpcService } from './gprc/world_engine_client_grpc.service';

interface ConnectionProps {
  apiKey: ApiKey;
  name?: string;
  user?: UserRequest;
  client?: ClientRequest;
  config?: InternalClientConfiguration;
  sessionGetterSetter?: GetterSetter<Session>;
  onDisconnect?: () => void;
  onError?: (err: ServiceError) => void;
  onMessage?: (message: InworldPacket) => Awaitable<void>;
  generateSessionToken?: GenerateSessionTokenFn;
}

export interface QueueItem {
  getPacket: () => ProtoPacket;
  afterWriting?: (packet: ProtoPacket) => void;
}

export class ConnectionService {
  private state: ConnectionState = ConnectionState.INACTIVE;

  private scene: Scene;
  private sessionToken: SessionToken;
  private stream: ClientDuplexStream<ProtoPacket, ProtoPacket>;
  private connectionProps: ConnectionProps;

  private disconnectTimeoutId: NodeJS.Timeout;

  private eventFactory = new EventFactory();

  private intervals: NodeJS.Timeout[] = [];
  private packetQueue: QueueItem[] = [];

  private tokenService = new TokenClientGrpcService();
  private engineService = new WorldEngineClientGrpcService();

  private onDisconnect: () => void;
  private onError: (err: ServiceError) => void;
  private onMessage: ((message: ProtoPacket) => Awaitable<void>) | undefined;

  constructor(props: ConnectionProps) {
    this.connectionProps = props;

    this.onDisconnect = () => {
      this.state = ConnectionState.INACTIVE;
      this.connectionProps.onDisconnect?.();
    };
    this.onError =
      this.connectionProps.onError ??
      ((err: ServiceError) => console.error(err));

    if (this.connectionProps.onMessage) {
      this.onMessage = async (packet: ProtoPacket) =>
        this.connectionProps.onMessage(EventFactory.fromProto(packet));
    }
  }

  isActive() {
    return this.state === ConnectionState.ACTIVE;
  }

  isAutoReconnected() {
    return this.connectionProps.config?.connection?.autoReconnect ?? true;
  }

  async generateSessionToken() {
    const proto = await this.tokenService.generateSessionToken(
      this.connectionProps.apiKey,
    );

    return SessionToken.fromProto(proto);
  }

  async openManually() {
    try {
      if (this.isAutoReconnected()) {
        throw Error(
          'Impossible to open connection manually with `autoReconnect` enabled',
        );
      }

      if (this.isActive()) {
        throw Error('Connection is already open');
      }

      return this.open();
    } catch (err) {
      this.onError(err);
    }
  }

  close() {
    this.cancelScheduler();
    this.state = ConnectionState.INACTIVE;
    if (this.connectionProps.onMessage) {
      this.stream?.removeListener('data', this.onMessage);
    }
    this.stream?.cancel();
    this.clearQueue();
  }

  getEventFactory() {
    return this.eventFactory;
  }

  async getCharactersList() {
    if (!this.scene) {
      await this.loadScene();
    }

    return this.scene.characters;
  }

  async open() {
    try {
      await this.loadScene();

      if (this.state === ConnectionState.LOADED) {
        this.state = ConnectionState.ACTIVATING;

        this.stream = this.engineService.session({
          sessionToken: this.sessionToken,
          onError: this.onError,
          onDisconnect: this.onDisconnect,
          ...(this.onMessage && { onMessage: this.onMessage }),
        });

        this.state = ConnectionState.ACTIVE;
        this.releaseQueue();

        this.scheduleDisconnect();
      }
    } catch (err) {
      this.onError(err);
      this.clearQueue();
    }
  }

  async send(getPacket: () => ProtoPacket) {
    try {
      this.cancelScheduler();

      if (!this.isActive() && !this.isAutoReconnected()) {
        throw Error('Unable to send data due inactive connection');
      }

      return this.write(getPacket);
    } catch (err) {
      this.onError(err);
    }
  }

  private async write(getPacket: () => ProtoPacket) {
    let packet: ProtoPacket;

    const resolvePacket = () =>
      new Promise<InworldPacket>((resolve) => {
        const done = (packet: ProtoPacket) => {
          this.scheduleDisconnect();
          resolve(EventFactory.fromProto(packet));
        };

        if (packet) {
          return done(packet);
        }

        const interval = setInterval(() => {
          if (packet || this.state === ConnectionState.INACTIVE) {
            clearInterval(interval);

            this.intervals = this.intervals.filter(
              (i: NodeJS.Timeout) => i !== interval,
            );

            done(packet);
          }
        }, 10);
        this.intervals.push(interval);
      });

    if (this.isActive()) {
      packet = this.writeToStream(getPacket);
    } else {
      this.packetQueue.push({
        getPacket,
        afterWriting: (protoPacket: ProtoPacket) => {
          packet = protoPacket;
        },
      });

      await this.open();
    }

    return resolvePacket();
  }

  private writeToStream(getPacket: () => ProtoPacket) {
    const packet = getPacket();

    this.stream?.write(getPacket());

    return packet;
  }

  private async loadScene() {
    if (this.state === ConnectionState.LOADING) return;

    let session: Session;
    let changed = false;

    // Try to get session from provided storage
    if (this.connectionProps.sessionGetterSetter) {
      session = await this.connectionProps.sessionGetterSetter.get();
    }

    try {
      const sessionToken = await this.getOrLoadSessionToken(
        session?.sessionToken,
      );
      changed = sessionToken !== this.sessionToken || changed;

      this.sessionToken = sessionToken;

      if (!this.scene) {
        const scene = await this.getOrLoadScene(session?.scene);
        changed = scene !== this.scene || changed;

        this.scene = scene;

        if (
          !this.getEventFactory().getCurrentCharacter() &&
          this.scene.characters.length
        ) {
          this.getEventFactory().setCurrentCharacter(this.scene.characters[0]);
        }
      }

      // Try to save session token to provided storage
      if (changed) {
        this.connectionProps.sessionGetterSetter?.set({
          sessionToken: this.sessionToken,
          scene: this.scene,
        });
      }

      if (
        [ConnectionState.LOADING, ConnectionState.INACTIVE].includes(this.state)
      ) {
        this.state = ConnectionState.LOADED;
      }
    } catch (err) {
      this.onError(err);
    }
  }

  private async getOrLoadSessionToken(savedSessionToken?: SessionToken) {
    let sessionToken = savedSessionToken ?? this.sessionToken;

    const { sessionId } = sessionToken || {};

    // Generate new session token is it's empty or expired
    if (!sessionToken || SessionToken.isExpired(sessionToken)) {
      this.state = ConnectionState.LOADING;

      const generateSessionToken =
        this.connectionProps.generateSessionToken ??
        this.generateSessionToken.bind(this);
      sessionToken = await generateSessionToken();

      // Reuse session id to keep context of previous conversation
      if (sessionId) {
        sessionToken = new SessionToken({
          ...sessionToken,
          sessionId,
        });
      }
    }

    return sessionToken;
  }

  private async getOrLoadScene(savedScene?: Scene) {
    let scene = savedScene;

    // Load scene
    if (!scene) {
      const { client, name, user } = this.connectionProps;

      const proto = await this.engineService.loadScene({
        client,
        name,
        user,
        capabilities: this.connectionProps.config.capabilities,
        sessionToken: this.sessionToken,
      });

      scene = Scene.fromProto(proto);
    }

    return scene;
  }

  private scheduleDisconnect() {
    if (this.connectionProps.config?.connection?.disconnectTimeout) {
      this.cancelScheduler();
      this.disconnectTimeoutId = setTimeout(
        () => this.close(),
        this.connectionProps.config.connection.disconnectTimeout,
      );
    }
  }

  private cancelScheduler() {
    if (this.disconnectTimeoutId) {
      clearTimeout(this.disconnectTimeoutId);
    }
  }

  private releaseQueue() {
    this.packetQueue.forEach((item: QueueItem) => {
      const protoPacket = this.writeToStream(item.getPacket);
      item.afterWriting?.(protoPacket);
    });

    this.packetQueue = [];
  }

  private clearQueue() {
    this.intervals.forEach((i: NodeJS.Timeout) => {
      clearInterval(i);
    });

    this.intervals = [];
    this.packetQueue = [];
  }
}
