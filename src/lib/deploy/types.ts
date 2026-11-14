export type ResourceKind =
  | 'lambda'
  | 'sqs'
  | 'sns'
  | 's3'
  | 'dynamodb'
  | 'secret'
  | 'log-group'
  | 'event-rule'
  | 'event-bus'
  | 'scheduler'
  | 'event-source-mapping'
  | 'apigateway'
  | 'apigatewayv2'
  | 'sfn'
  | 'ecs-cluster'
  | 'ecs-task-definition'
  | 'ecs-service'
  | 'ecr'
  | 'alb'
  | 'target-group'
  | 'listener'
  | 'other';

export type ConfigKind = 'serverless' | 'trinity';

export interface DeployOptions {
  source: string;
  stage: string;
  region: string;
  endpoint: string;
  dryRun: boolean;
  noBuild: boolean;
  desiredCount?: number;
  kind?: ConfigKind;
  /** Path to a local .env / .env.local used to fill placeholder secrets. Never sent to real AWS. */
  envFile?: string;
  /** Create resources but do not start work: disabled triggers, ECS desiredCount 0. */
  noRun?: boolean;
  /** --region was passed explicitly: it overrides provider.region / the trinity file's region. */
  regionFromFlag?: boolean;
  /**
   * --fallback-stage: stages tried, in order, when a stage-keyed lookup (e.g. ${self:custom.${sls:stage}.x},
   * ${custom.${custom.stage}.cpu}) has no value for --stage and no explicit default. Default ['dev']; [] disables it.
   */
  fallbackStages?: string[];
}

export interface PlannedResource {
  kind: ResourceKind;
  name: string;
  action: 'create' | 'update' | 'skip';
  detail?: string;
  href?: string;
}

export interface Plan {
  kind: ConfigKind;
  service: string;
  source: string;
  stage: string;
  region: string;
  resources: PlannedResource[];
  placeholders: { name: string; keys: string[]; filled?: string[]; defaulted?: string[]; missing?: string[] }[];
  warnings: string[];
  unsupported: string[];
}

export interface ManifestResource {
  kind: ResourceKind;
  name: string;
  id?: string;
  arn?: string;
  url?: string;
  href?: string;
  extra?: Record<string, string>;
}

export interface DeployManifest {
  id: string;
  kind: ConfigKind;
  service: string;
  stage: string;
  region: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  resources: ManifestResource[];
  placeholders: { name: string; keys: string[]; filled?: string[]; defaulted?: string[]; missing?: string[] }[];
  warnings: string[];
}

export const DEPLOY_TAG = {
  deploy: 'aws-emulator:deploy',
  source: 'aws-emulator:source',
  stage: 'aws-emulator:stage',
  kind: 'aws-emulator:kind',
  service: 'aws-emulator:service',
} as const;

export const PLACEHOLDER_VALUE = 'PLACEHOLDER — set this value in Floci Secrets Manager';

export function uiHref(kind: ResourceKind, name?: string): string {
  const map: Record<ResourceKind, string> = {
    lambda: '/lambda',
    sqs: '/sqs',
    sns: '/sns',
    s3: '/s3',
    dynamodb: '/dynamodb',
    secret: '/secrets',
    'log-group': name ? `/logs/${encodeURIComponent(name)}` : '/logs',
    'event-rule': '/eventbridge',
    'event-bus': '/eventbridge',
    scheduler: '/eventbridge',
    'event-source-mapping': '/lambda',
    apigateway: '/apigateway',
    apigatewayv2: '/apigateway',
    sfn: '/stepfunctions',
    'ecs-cluster': '/ecs',
    'ecs-task-definition': '/ecs',
    'ecs-service': '/ecs',
    ecr: '/ecr',
    alb: '/elb',
    'target-group': '/elb',
    listener: '/elb',
    other: '/',
  };
  return map[kind];
}

export function manifestId(service: string, stage: string, kind: ConfigKind, source?: string): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const extra = source ? `-${slug(source.split('/').slice(-2).join('-'))}` : '';
  return `${slug(service)}-${slug(stage)}-${kind}${extra}`.replace(/--+/g, '-');
}
