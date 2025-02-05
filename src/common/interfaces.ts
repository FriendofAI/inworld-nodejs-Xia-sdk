import { CapabilitiesRequest } from '@proto/world-engine_pb';

import { SessionToken } from '../entities/session_token.entity';

export interface ApiKey {
  key: string;
  secret: string;
}

export interface Capabilities {
  audio?: boolean;
  emotions?: boolean;
  interruptions?: boolean;
  phonemes?: boolean;
  silence?: boolean;
}

export interface User {
  fullName: string;
}

export interface Client {
  id?: string;
}

export interface ConnectionConfig {
  autoReconnect?: boolean;
  disconnectTimeout?: number;
}

export interface ClientConfiguration {
  connection?: ConnectionConfig;
  capabilities?: Capabilities;
}

export interface InternalClientConfiguration {
  connection?: ConnectionConfig;
  capabilities: CapabilitiesRequest;
}

export type Awaitable<T> = T | PromiseLike<T>;
export type GenerateSessionTokenFn = () => Promise<SessionToken>;

export interface CancelResponsesProps {
  interactionId?: string;
  utteranceId?: string[];
}

export interface SessionTokenProps {
  token: string;
  type: string;
  expirationTime: Date;
  sessionId: string;
}

export interface GetterSetter<T> {
  get: () => Awaitable<T | undefined>;
  set: (entity: T) => Awaitable<any>;
}

export enum ConnectionState {
  ACTIVE = 'ACTIVE',
  ACTIVATING = 'ACTIVATING',
  LOADED = 'LOADED',
  LOADING = 'LOADING',
  INACTIVE = 'INACTIVE',
}
