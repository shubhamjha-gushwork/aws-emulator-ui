import {
  APIGatewayClient, GetRestApisCommand, CreateRestApiCommand, DeleteRestApiCommand, GetResourcesCommand, GetStagesCommand,
  GetDeploymentsCommand, CreateDeploymentCommand, CreateResourceCommand, PutMethodCommand, PutIntegrationCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client, GetApisCommand, CreateApiCommand, DeleteApiCommand, GetRoutesCommand, GetStagesCommand as GetStagesV2Command,
  GetIntegrationsCommand, CreateRouteCommand, CreateStageCommand, DeleteRouteCommand, ExportApiCommand,
} from '@aws-sdk/client-apigatewayv2';
import { type ServiceModule, str, optStr, safeCount, decodeBytes } from './types';

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
      await c.send(new PutMethodCommand({ restApiId, resourceId: res.id!, httpMethod: method, authorizationType: 'NONE' }));
      await c.send(new PutIntegrationCommand({ restApiId, resourceId: res.id!, httpMethod: method, type: 'MOCK', requestTemplates: { 'application/json': '{"statusCode": 200}' } }));
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
      return ctx.client(ApiGatewayV2Client).send(new CreateRouteCommand({ ApiId: str(p, 'id'), RouteKey: str(p, 'routeKey') }));
    },
    async deleteHttpRoute(ctx, p) {
      await ctx.client(ApiGatewayV2Client).send(new DeleteRouteCommand({ ApiId: str(p, 'id'), RouteId: str(p, 'routeId') }));
      return { deleted: true };
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
