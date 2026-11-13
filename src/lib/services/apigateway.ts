import {
  APIGatewayClient, GetRestApisCommand, CreateRestApiCommand, DeleteRestApiCommand, GetResourcesCommand, GetStagesCommand,
  GetDeploymentsCommand, CreateDeploymentCommand, CreateResourceCommand, PutMethodCommand, PutIntegrationCommand,
  PutMethodResponseCommand, PutIntegrationResponseCommand,
} from '@aws-sdk/client-api-gateway';
import http from 'node:http';
import https from 'node:https';
import type { BackendId } from '../backends';
import {
  ApiGatewayV2Client, GetApisCommand, CreateApiCommand, DeleteApiCommand, GetRoutesCommand, GetStagesCommand as GetStagesV2Command,
  GetIntegrationsCommand, CreateRouteCommand, CreateStageCommand, DeleteRouteCommand, ExportApiCommand, CreateIntegrationCommand,
} from '@aws-sdk/client-apigatewayv2';
import { type ServiceModule, str, optStr, safeCount, decodeBytes, InputError } from './types';

/** Data-plane paths for a test invoke. AWS Emulator uses `/_aws/execute-api/…`; Floci uses `/restapis/…/_user_request_` and `/execute-api/…`. */
function executePaths(backend: BackendId | undefined, id: string, stage: string, path: string): string[] {
  if (backend === 'floci') {
    if (stage === '$default') {
      return [`/execute-api/${id}${path}`, `/execute-api/${id}/$default${path}`, `/_aws/execute-api/${id}${path}`];
    }
    return [
      `/restapis/${id}/${encodeURIComponent(stage)}/_user_request_${path}`,
      `/execute-api/${id}/${encodeURIComponent(stage)}${path}`,
      `/_aws/execute-api/${id}/${encodeURIComponent(stage)}${path}`,
    ];
  }
  const prefix = stage === '$default' ? `/_aws/execute-api/${id}` : `/_aws/execute-api/${id}/${encodeURIComponent(stage)}`;
  return [`${prefix}${path}`];
}

function invokeDataPlane(endpoint: string, httpsAgent: https.Agent, path: string, method: string, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string; url: string }>((resolve, reject) => {
    const url = new URL(path, endpoint);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      { method, agent: url.protocol === 'https:' ? httpsAgent : undefined, headers: body ? { 'content-type': 'application/json' } : {}, timeout: 30000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), body: data.slice(0, 64 * 1024), url: url.toString() }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timed out after 30s')));
    if (body) req.write(body);
    req.end();
  });
}

export const apigateway: ServiceModule = {
  async counts(ctx) {
    const v1 = ctx.client(APIGatewayClient);
    const v2 = ctx.client(ApiGatewayV2Client);
    return [
      { label: 'REST APIs', value: await safeCount(async () => (await v1.send(new GetRestApisCommand({ limit: 500 }))).items?.length ?? 0) },
      { label: 'HTTP APIs', value: await safeCount(async () => (await v2.send(new GetApisCommand({}))).Items?.length ?? 0) },
    ];
  },
  actions: {
    // ---- REST (v1)
    async restApis(ctx) {
      return (await ctx.client(APIGatewayClient).send(new GetRestApisCommand({ limit: 500 }))).items ?? [];
    },
    async createRestApi(ctx, p) {
      return ctx.client(APIGatewayClient).send(new CreateRestApiCommand({ name: str(p, 'name'), description: optStr(p, 'description'), endpointConfiguration: { types: ['REGIONAL'] } }));
    },
    async deleteRestApi(ctx, p) {
      await ctx.client(APIGatewayClient).send(new DeleteRestApiCommand({ restApiId: str(p, 'id') }));
      return { deleted: true };
    },
    async restResources(ctx, p) {
      return (await ctx.client(APIGatewayClient).send(new GetResourcesCommand({ restApiId: str(p, 'id'), limit: 500, embed: ['methods'] }))).items ?? [];
    },
    async restStages(ctx, p) {
      return (await ctx.client(APIGatewayClient).send(new GetStagesCommand({ restApiId: str(p, 'id') }))).item ?? [];
    },
    async restDeployments(ctx, p) {
      return (await ctx.client(APIGatewayClient).send(new GetDeploymentsCommand({ restApiId: str(p, 'id') }))).items ?? [];
    },
    /** Adds a MOCK-integrated method on a new path part — handy for wiring a quick test endpoint. */
    async addMockMethod(ctx, p) {
      const c = ctx.client(APIGatewayClient);
      const restApiId = str(p, 'id');
      const method = (optStr(p, 'method') ?? 'GET').toUpperCase();
      const resources = (await c.send(new GetResourcesCommand({ restApiId, limit: 500 }))).items ?? [];
      const root = resources.find((r) => r.path === '/');
      const pathPart = str(p, 'pathPart');
      const existing = resources.find((r) => r.path === `/${pathPart}`);
      const res = existing ?? (await c.send(new CreateResourceCommand({ restApiId, parentId: root!.id!, pathPart })));
      try {
        await c.send(new PutMethodCommand({ restApiId, resourceId: res.id!, httpMethod: method, authorizationType: 'NONE' }));
      } catch (e) {
        if ((e as Error).name !== 'ConflictException') throw e; // method exists: just (re)configure its MOCK integration
      }
      await c.send(new PutIntegrationCommand({ restApiId, resourceId: res.id!, httpMethod: method, type: 'MOCK', requestTemplates: { 'application/json': '{"statusCode": 200}' } }));
      // Without a method + integration response, a MOCK integration answers 500 "Internal server error" (as on AWS).
      await c.send(new PutMethodResponseCommand({ restApiId, resourceId: res.id!, httpMethod: method, statusCode: '200' })).catch((e: Error) => {
        if (e.name !== 'ConflictException') throw e;
      });
      await c.send(
        new PutIntegrationResponseCommand({
          restApiId, resourceId: res.id!, httpMethod: method, statusCode: '200',
          responseTemplates: { 'application/json': optStr(p, 'responseBody') ?? `{"ok": true, "mock": true, "path": "/${pathPart}"}` },
        }),
      );
      return { resourceId: res.id, path: `/${pathPart}`, method };
    },
    async createDeployment(ctx, p) {
      return ctx.client(APIGatewayClient).send(new CreateDeploymentCommand({ restApiId: str(p, 'id'), stageName: str(p, 'stage'), description: optStr(p, 'description') }));
    },
    // ---- HTTP / WebSocket (v2)
    async httpApis(ctx) {
      return (await ctx.client(ApiGatewayV2Client).send(new GetApisCommand({}))).Items ?? [];
    },
    async createHttpApi(ctx, p) {
      return ctx.client(ApiGatewayV2Client).send(new CreateApiCommand({ Name: str(p, 'name'), ProtocolType: 'HTTP', Description: optStr(p, 'description') }));
    },
    async deleteHttpApi(ctx, p) {
      await ctx.client(ApiGatewayV2Client).send(new DeleteApiCommand({ ApiId: str(p, 'id') }));
      return { deleted: true };
    },
    async httpRoutes(ctx, p) {
      return (await ctx.client(ApiGatewayV2Client).send(new GetRoutesCommand({ ApiId: str(p, 'id') }))).Items ?? [];
    },
    async httpStages(ctx, p) {
      return (await ctx.client(ApiGatewayV2Client).send(new GetStagesV2Command({ ApiId: str(p, 'id') }))).Items ?? [];
    },
    async httpIntegrations(ctx, p) {
      return (await ctx.client(ApiGatewayV2Client).send(new GetIntegrationsCommand({ ApiId: str(p, 'id') }))).Items ?? [];
    },
    async createHttpRoute(ctx, p) {
      const c = ctx.client(ApiGatewayV2Client);
      const ApiId = str(p, 'id');
      const lambdaArn = optStr(p, 'lambdaArn');
      let Target: string | undefined;
      if (lambdaArn) {
        // Lambda proxy integration (payload format 2.0), the usual HTTP API backend.
        const integ = await c.send(new CreateIntegrationCommand({ ApiId, IntegrationType: 'AWS_PROXY', IntegrationUri: lambdaArn, PayloadFormatVersion: '2.0' }));
        Target = `integrations/${integ.IntegrationId}`;
      }
      return c.send(new CreateRouteCommand({ ApiId, RouteKey: str(p, 'routeKey'), Target }));
    },
    async deleteHttpRoute(ctx, p) {
      await ctx.client(ApiGatewayV2Client).send(new DeleteRouteCommand({ ApiId: str(p, 'id'), RouteId: str(p, 'routeId') }));
      return { deleted: true };
    },
    /** Test-invoke a deployed REST stage or HTTP API route through the emulator's data plane. */
    async invoke(ctx, p) {
      const id = str(p, 'id');
      if (!/^[a-z0-9]+$/i.test(id)) throw new InputError('Invalid API id');
      const stage = optStr(p, 'stage') ?? '$default';
      const method = (optStr(p, 'method') ?? 'GET').toUpperCase();
      const path = optStr(p, 'path') ?? '/';
      if (!/^\/[\w\-./{}~%]*$/.test(path)) throw new InputError('Path must start with / and contain only URL path characters');
      const body = optStr(p, 'body');
      const paths = executePaths(ctx.cfg.backend, id, stage, path);
      let last: Awaited<ReturnType<typeof invokeDataPlane>> | undefined;
      for (const pth of paths) {
        last = await invokeDataPlane(ctx.cfg.endpoint, ctx.cfg.httpsAgent, pth, method, body);
        if (last.status !== 404) return last;
      }
      return last!;
    },
    /** OpenAPI 3.0 export (the emulator currently answers NotImplemented — the UI shows that state). */
    async exportHttpApi(ctx, p) {
      const r = await ctx.client(ApiGatewayV2Client).send(new ExportApiCommand({ ApiId: str(p, 'id'), OutputType: 'JSON', Specification: 'OAS30' }));
      return { body: decodeBytes(r.body) };
    },
    async createHttpStage(ctx, p) {
      return ctx.client(ApiGatewayV2Client).send(new CreateStageCommand({ ApiId: str(p, 'id'), StageName: str(p, 'stage'), AutoDeploy: true }));
    },
  },
};
