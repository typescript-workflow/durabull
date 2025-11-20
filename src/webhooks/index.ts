import { createHmac } from 'crypto';
import { WorkflowStub } from '../WorkflowStub';
import { Workflow } from '../Workflow';
import { getWebhookMethods, getSignalMethods } from '../decorators';
import { Durabull } from '../config/global';
import { createLoggerFromConfig } from '../runtime/logger';

type WorkflowConstructor = new () => Workflow<unknown[], unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

export interface AuthStrategy {
  authenticate(request: WebhookRequest): Promise<boolean>;
}

export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface WebhookResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class NoneAuthStrategy implements AuthStrategy {
  async authenticate(_request: WebhookRequest): Promise<boolean> {
    return true;
  }
}

export class TokenAuthStrategy implements AuthStrategy {
  private token: string;
  private header: string;

  constructor(token: string, header: string = 'Authorization') {
    this.token = token;
    this.header = header;
  }

  async authenticate(request: WebhookRequest): Promise<boolean> {
    const headerValue = request.headers[this.header] || request.headers[this.header.toLowerCase()];
    
    if (!headerValue) return false;
    
    if (headerValue.startsWith('Bearer ')) {
      return headerValue.substring(7) === this.token;
    }
    
    return headerValue === this.token;
  }
}

export class SignatureAuthStrategy implements AuthStrategy {
  private secret: string;
  private header: string;

  constructor(secret: string, header: string = 'X-Signature') {
    this.secret = secret;
    this.header = header;
  }

  async authenticate(request: WebhookRequest): Promise<boolean> {
    const signature = request.headers[this.header] || request.headers[this.header.toLowerCase()];
    
    if (!signature) return false;
    
    const bodyStr = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const expectedSignature = createHmac('sha256', this.secret)
      .update(bodyStr)
      .digest('hex');
    
    return signature === expectedSignature;
  }
}

export interface WebhookRouterConfig {
  authStrategy?: AuthStrategy;
  workflowRegistry?: Map<string, WorkflowConstructor>;
}

const workflowRegistry = new Map<string, WorkflowConstructor>();

export function registerWebhookWorkflow(name: string, WorkflowClass: WorkflowConstructor): void {
  workflowRegistry.set(name, WorkflowClass);
}

export class WebhookRouter {
  private authStrategy: AuthStrategy;
  private registry: Map<string, WorkflowConstructor>;

  constructor(config: WebhookRouterConfig = {}) {
    if (!config.authStrategy) {
      throw new Error('WebhookRouter requires an authentication strategy. Use NoneAuthStrategy explicitly if you want no authentication (not recommended for production).');
    }
    this.authStrategy = config.authStrategy;
    this.registry = config.workflowRegistry || workflowRegistry;
  }

  async handle(request: WebhookRequest): Promise<WebhookResponse> {
    const isAuthenticated = await this.authStrategy.authenticate(request);
    if (!isAuthenticated) {
      return {
        statusCode: 401,
        body: { error: 'Unauthorized' },
      };
    }

    const pathParts = request.path.split('/').filter(p => p);
    
    if (request.method === 'POST' && pathParts[0] === 'start' && pathParts.length === 2) {
      return await this.handleStart(pathParts[1], request.body);
    }
    
    if (request.method === 'POST' && pathParts[0] === 'signal' && pathParts.length === 4) {
      return await this.handleSignal(pathParts[1], pathParts[2], pathParts[3], request.body);
    }
    
    return {
      statusCode: 404,
      body: { error: 'Not found' },
    };
  }

  private async handleStart(workflowName: string, body: unknown): Promise<WebhookResponse> {
    try {
      const WorkflowClass = this.registry.get(workflowName);
      if (!WorkflowClass) {
        return {
          statusCode: 404,
          body: { error: `Workflow ${workflowName} not found` },
        };
      }

      // Check if the workflow start (execute method) is exposed via webhook
      const webhookMethods = getWebhookMethods(WorkflowClass);
      if (!webhookMethods.includes('execute')) {
        return {
          statusCode: 404,
          body: { error: 'Not found' },
        };
      }
      
  const payload = isRecord(body) ? body : {};
  const args: unknown[] = Array.isArray(payload.args) ? payload.args : [];
      const id = typeof payload.id === 'string' ? payload.id : undefined;
      
      const handle = await WorkflowStub.make(WorkflowClass, id ? { id } : undefined);
      await handle.start(...args);
      
      return {
        statusCode: 200,
        body: { 
          workflowId: handle.id,
          status: 'started',
        },
      };
    } catch (error) {
      const instance = Durabull.getActive();
      const logger = createLoggerFromConfig(instance?.getConfig().logger);
      const requestId = Math.random().toString(36).substring(7);
      logger.error(`Webhook start failed (req=${requestId})`, error);
      return {
        statusCode: 500,
        body: { error: 'Internal Server Error', requestId },
      };
    }
  }

  private async handleSignal(
    workflowName: string, 
    workflowId: string, 
    signalName: string, 
    body: unknown
  ): Promise<WebhookResponse> {
    try {
      const WorkflowClass = this.registry.get(workflowName);
      if (!WorkflowClass) {
        return {
          statusCode: 404,
          body: { error: `Workflow ${workflowName} not found` },
        };
      }

      const signalMethods = getSignalMethods(WorkflowClass);
      if (!signalMethods.includes(signalName)) {
        return {
          statusCode: 404,
          body: { error: `Signal ${signalName} not found on workflow ${workflowName}` },
        };
      }

      const webhookMethods = getWebhookMethods(WorkflowClass);
      if (webhookMethods.length === 0 || !webhookMethods.includes(signalName)) {
        return {
          statusCode: 404,
          body: { error: 'Not found' },
        };
      }

      const rawPayload = isRecord(body) ? body.payload : undefined;
      const payload: unknown[] = Array.isArray(rawPayload)
        ? rawPayload
        : rawPayload !== undefined ? [rawPayload] : [];

      await WorkflowStub.sendSignal(workflowId, signalName, payload);
      
      return {
        statusCode: 200,
        body: { 
          workflowId,
          signal: signalName,
          status: 'sent',
        },
      };
    } catch (error) {
      const instance = Durabull.getActive();
      const logger = createLoggerFromConfig(instance?.getConfig().logger);
      const requestId = Math.random().toString(36).substring(7);
      logger.error(`Webhook signal failed (req=${requestId})`, error);
      return {
        statusCode: 500,
        body: { error: 'Internal Server Error', requestId },
      };
    }
  }
}

export function createWebhookRouter(config?: WebhookRouterConfig): WebhookRouter {
  return new WebhookRouter(config);
}
