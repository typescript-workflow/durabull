/**
 * Webhook HTTP router for workflow control
 * 
 * Provides REST API endpoints for starting workflows and sending signals
 * with configurable authentication strategies
 */

import { createHmac } from 'crypto';
import { Durabull } from '../config/global';
import { WorkflowStub } from '../WorkflowStub';
import { Workflow } from '../Workflow';

type WorkflowConstructor = new () => Workflow<unknown[], unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

/**
 * Auth strategy interface
 */
export interface AuthStrategy {
  authenticate(request: WebhookRequest): Promise<boolean>;
}

/**
 * Simple request interface (framework-agnostic)
 */
export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Simple response interface (framework-agnostic)
 */
export interface WebhookResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * No authentication - all requests allowed
 */
export class NoneAuthStrategy implements AuthStrategy {
  async authenticate(_request: WebhookRequest): Promise<boolean> {
    return true;
  }
}

/**
 * Token-based authentication
 */
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
    
    // Support "Bearer <token>" format
    if (headerValue.startsWith('Bearer ')) {
      return headerValue.substring(7) === this.token;
    }
    
    return headerValue === this.token;
  }
}

/**
 * Signature-based authentication (HMAC)
 */
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
    
    // Compute HMAC signature of request body
    const bodyStr = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const expectedSignature = createHmac('sha256', this.secret)
      .update(bodyStr)
      .digest('hex');
    
    return signature === expectedSignature;
  }
}

/**
 * Webhook router configuration
 */
export interface WebhookRouterConfig {
  authStrategy?: AuthStrategy;
  workflowRegistry?: Map<string, WorkflowConstructor>;
}

/**
 * Workflow registry for webhook routing
 */
const workflowRegistry = new Map<string, WorkflowConstructor>();

/**
 * Register a workflow class for webhook access
 */
export function registerWebhookWorkflow(name: string, WorkflowClass: WorkflowConstructor): void {
  workflowRegistry.set(name, WorkflowClass);
}

/**
 * Simple webhook router
 */
export class WebhookRouter {
  private authStrategy: AuthStrategy;
  private registry: Map<string, WorkflowConstructor>;

  constructor(config: WebhookRouterConfig = {}) {
    this.authStrategy = config.authStrategy || new NoneAuthStrategy();
    this.registry = config.workflowRegistry || workflowRegistry;
  }

  /**
   * Handle webhook request
   */
  async handle(request: WebhookRequest): Promise<WebhookResponse> {
    // Authenticate
    const isAuthenticated = await this.authStrategy.authenticate(request);
    if (!isAuthenticated) {
      return {
        statusCode: 401,
        body: { error: 'Unauthorized' },
      };
    }

    // Route based on path
    const pathParts = request.path.split('/').filter(p => p);
    
    // POST /start/:workflow
    if (request.method === 'POST' && pathParts[0] === 'start' && pathParts.length === 2) {
      return await this.handleStart(pathParts[1], request.body);
    }
    
    // POST /signal/:workflow/:id/:signal
    if (request.method === 'POST' && pathParts[0] === 'signal' && pathParts.length === 4) {
      return await this.handleSignal(pathParts[1], pathParts[2], pathParts[3], request.body);
    }
    
    return {
      statusCode: 404,
      body: { error: 'Not found' },
    };
  }

  /**
   * Handle workflow start
   */
  private async handleStart(workflowName: string, body: unknown): Promise<WebhookResponse> {
    try {
      const WorkflowClass = this.registry.get(workflowName);
      if (!WorkflowClass) {
        return {
          statusCode: 404,
          body: { error: `Workflow ${workflowName} not found` },
        };
      }

  const payload = isRecord(body) ? body : {};
  const args: unknown[] = Array.isArray(payload.args) ? payload.args : [];
      const id = typeof payload.id === 'string' ? payload.id : undefined;
      
      const handle = await WorkflowStub.make(WorkflowClass, id);
      await handle.start(...args);
      
      return {
        statusCode: 200,
        body: { 
          workflowId: handle.id(),
          status: 'started',
        },
      };
    } catch (error) {
      return {
        statusCode: 500,
        body: { error: (error as Error).message },
      };
    }
  }

  /**
   * Handle signal send
   */
  private async handleSignal(
    _workflowName: string, 
    workflowId: string, 
    signalName: string, 
    body: unknown
  ): Promise<WebhookResponse> {
    try {
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
      return {
        statusCode: 500,
        body: { error: (error as Error).message },
      };
    }
  }
}

/**
 * Create webhook router with configured auth strategy
 */
export function createWebhookRouter(config?: WebhookRouterConfig): WebhookRouter {
  const durabullConfig = Durabull.isConfigured() ? Durabull.getConfig() : null;
  
  let authStrategy: AuthStrategy;
  
  if (config?.authStrategy) {
    authStrategy = config.authStrategy;
  } else if (durabullConfig?.webhooks?.auth) {
    const auth = durabullConfig.webhooks.auth;
    
    switch (auth.method) {
      case 'token':
        authStrategy = new TokenAuthStrategy(auth.token!, auth.header);
        break;
      case 'signature':
        authStrategy = new SignatureAuthStrategy(auth.token!, auth.header);
        break;
      case 'custom':
        throw new Error('Custom auth strategy must be provided in config');
      default:
        authStrategy = new NoneAuthStrategy();
    }
  } else {
    authStrategy = new NoneAuthStrategy();
  }
  
  return new WebhookRouter({
    authStrategy,
    workflowRegistry: config?.workflowRegistry,
  });
}
