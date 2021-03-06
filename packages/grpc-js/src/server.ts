/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import * as http2 from 'http2';
import {AddressInfo, ListenOptions} from 'net';
import {URL} from 'url';

import {ServiceError} from './call';
import {Status} from './constants';
import {Deserialize, Serialize, ServiceDefinition} from './make-client';
import {HandleCall, Handler, HandlerType, sendUnaryData, ServerDuplexStream, ServerReadableStream, ServerUnaryCall, ServerWritableStream} from './server-call';
import {ServerCredentials} from './server-credentials';

function noop(): void {}

type PartialServiceError = Partial<ServiceError>;
const unimplementedStatusResponse: PartialServiceError = {
  code: Status.UNIMPLEMENTED,
  details: 'The server does not implement this method',
};

// tslint:disable:no-any
type UntypedHandleCall = HandleCall<any, any>;
type UntypedHandler = Handler<any, any>;
type UntypedServiceImplementation = {
  [name: string]: UntypedHandleCall
};

const defaultHandler = {
  unary(call: ServerUnaryCall<any>, callback: sendUnaryData<any>): void {
    callback(unimplementedStatusResponse as ServiceError, null);
  },
  clientStream(call: ServerReadableStream<any>, callback: sendUnaryData<any>):
      void {
        callback(unimplementedStatusResponse as ServiceError, null);
      },
  serverStream(call: ServerWritableStream<any, any>): void {
    call.emit('error', unimplementedStatusResponse);
  },
  bidi(call: ServerDuplexStream<any, any>): void {
    call.emit('error', unimplementedStatusResponse);
  }
};
// tslint:enable:no-any

export class Server {
  private http2Server: http2.Http2Server|http2.Http2SecureServer|null = null;
  private handlers: Map<string, UntypedHandler> =
      new Map<string, UntypedHandler>();
  private started = false;

  constructor(options?: object) {}

  addProtoService(): void {
    throw new Error('Not implemented. Use addService() instead');
  }

  addService(service: ServiceDefinition, implementation: object): void {
    if (this.started === true) {
      throw new Error('Can\'t add a service to a started server.');
    }

    if (service === null || typeof service !== 'object' ||
        implementation === null || typeof implementation !== 'object') {
      throw new Error('addService() requires two objects as arguments');
    }

    const serviceKeys = Object.keys(service);

    if (serviceKeys.length === 0) {
      throw new Error('Cannot add an empty service to a server');
    }

    const implMap: UntypedServiceImplementation =
        implementation as UntypedServiceImplementation;

    serviceKeys.forEach((name) => {
      const attrs = service[name];
      let methodType: HandlerType;

      if (attrs.requestStream) {
        if (attrs.responseStream) {
          methodType = 'bidi';
        } else {
          methodType = 'clientStream';
        }
      } else {
        if (attrs.responseStream) {
          methodType = 'serverStream';
        } else {
          methodType = 'unary';
        }
      }

      let implFn = implMap[name];
      let impl;

      if (implFn === undefined && typeof attrs.originalName === 'string') {
        implFn = implMap[attrs.originalName];
      }

      if (implFn !== undefined) {
        impl = implFn.bind(implementation);
      } else {
        impl = defaultHandler[methodType];
      }

      const success = this.register(
          attrs.path, impl, attrs.responseSerialize, attrs.requestDeserialize,
          methodType);

      if (success === false) {
        throw new Error(`Method handler for ${attrs.path} already provided.`);
      }
    });
  }

  bind(port: string, creds: ServerCredentials): void {
    throw new Error('Not implemented. Use bindAsync() instead');
  }

  bindAsync(
      port: string, creds: ServerCredentials,
      callback: (error: Error|null, port: number) => void): void {
    if (this.started === true) {
      throw new Error('server is already started');
    }

    if (typeof port !== 'string') {
      throw new TypeError('port must be a string');
    }

    if (creds === null || typeof creds !== 'object') {
      throw new TypeError('creds must be an object');
    }

    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }

    const url = new URL(`http://${port}`);
    const options: ListenOptions = {host: url.hostname, port: +url.port};

    if (creds._isSecure()) {
      this.http2Server = http2.createSecureServer(
          creds._getSettings() as http2.SecureServerOptions);
    } else {
      this.http2Server = http2.createServer();
    }

    // TODO(cjihrig): Set up the handlers, to allow requests to be processed.

    function onError(err: Error): void {
      callback(err, -1);
    }

    this.http2Server.once('error', onError);

    this.http2Server.listen(options, () => {
      const server =
          this.http2Server as http2.Http2Server | http2.Http2SecureServer;
      const port = (server.address() as AddressInfo).port;

      server.removeListener('error', onError);
      callback(null, port);
    });
  }

  forceShutdown(): void {
    throw new Error('Not yet implemented');
  }

  register<RequestType, ResponseType>(
      name: string, handler: HandleCall<RequestType, ResponseType>,
      serialize: Serialize<ResponseType>, deserialize: Deserialize<RequestType>,
      type: string): boolean {
    if (this.handlers.has(name)) {
      return false;
    }

    this.handlers.set(
        name,
        {func: handler, serialize, deserialize, type: type as HandlerType});
    return true;
  }

  start(): void {
    if (this.http2Server === null || this.http2Server.listening !== true) {
      throw new Error('server must be bound in order to start');
    }

    if (this.started === true) {
      throw new Error('server is already started');
    }

    this.started = true;
  }

  tryShutdown(callback: (error?: Error) => void): void {
    callback = typeof callback === 'function' ? callback : noop;

    if (this.http2Server === null) {
      callback(new Error('server is not running'));
      return;
    }

    this.http2Server.close((err?: Error) => {
      this.started = false;
      callback(err);
    });
  }

  addHttp2Port(): void {
    throw new Error('Not yet implemented');
  }
}
