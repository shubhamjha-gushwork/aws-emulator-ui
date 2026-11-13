import {
  ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeListenersCommand, DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand, DescribeRulesCommand, CreateTargetGroupCommand, DeleteTargetGroupCommand, CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand, CreateListenerCommand, DeleteListenerCommand, RegisterTargetsCommand, type ProtocolEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import { type ServiceModule, str, optStr, num, strList, safeCount } from './types';

export const elb: ServiceModule = {
  async counts(ctx) {
    const c = ctx.client(ElasticLoadBalancingV2Client);
    return [
      { label: 'Load balancers', value: await safeCount(async () => (await c.send(new DescribeLoadBalancersCommand({}))).LoadBalancers?.length ?? 0) },
      { label: 'Target groups', value: await safeCount(async () => (await c.send(new DescribeTargetGroupsCommand({}))).TargetGroups?.length ?? 0) },
    ];
  },
  actions: {
    async loadBalancers(ctx) {
      return (await ctx.client(ElasticLoadBalancingV2Client).send(new DescribeLoadBalancersCommand({}))).LoadBalancers ?? [];
    },
    async listeners(ctx, p) {
      return (await ctx.client(ElasticLoadBalancingV2Client).send(new DescribeListenersCommand({ LoadBalancerArn: str(p, 'arn') }))).Listeners ?? [];
    },
    async rules(ctx, p) {
      return (await ctx.client(ElasticLoadBalancingV2Client).send(new DescribeRulesCommand({ ListenerArn: str(p, 'listenerArn') }))).Rules ?? [];
    },
    async targetGroups(ctx, p) {
      return (await ctx.client(ElasticLoadBalancingV2Client).send(new DescribeTargetGroupsCommand({ LoadBalancerArn: optStr(p, 'arn') }))).TargetGroups ?? [];
    },
    async targetHealth(ctx, p) {
      return (await ctx.client(ElasticLoadBalancingV2Client).send(new DescribeTargetHealthCommand({ TargetGroupArn: str(p, 'targetGroupArn') }))).TargetHealthDescriptions ?? [];
    },
    /** VPCs and subnets from the emulator's EC2, for the create forms. */
    async network(ctx) {
      const ec2 = ctx.client(EC2Client);
      const [v, s] = await Promise.all([ec2.send(new DescribeVpcsCommand({})), ec2.send(new DescribeSubnetsCommand({}))]);
      return {
        vpcs: (v.Vpcs ?? []).map((x) => ({ id: x.VpcId, cidr: x.CidrBlock, isDefault: x.IsDefault })),
        subnets: (s.Subnets ?? []).map((x) => ({ id: x.SubnetId, vpcId: x.VpcId, az: x.AvailabilityZone, cidr: x.CidrBlock })),
      };
    },
    async createTargetGroup(ctx, p) {
      const protocol = (optStr(p, 'protocol') ?? 'HTTP') as ProtocolEnum;
      return (
        await ctx.client(ElasticLoadBalancingV2Client).send(
          new CreateTargetGroupCommand({ Name: str(p, 'name'), Protocol: protocol, Port: num(p, 'port', 80), VpcId: str(p, 'vpcId'), TargetType: (optStr(p, 'targetType') as 'ip' | 'instance') ?? 'ip' }),
        )
      ).TargetGroups?.[0];
    },
    async deleteTargetGroup(ctx, p) {
      await ctx.client(ElasticLoadBalancingV2Client).send(new DeleteTargetGroupCommand({ TargetGroupArn: str(p, 'targetGroupArn') }));
      return { deleted: true };
    },
    async registerTarget(ctx, p) {
      await ctx.client(ElasticLoadBalancingV2Client).send(
        new RegisterTargetsCommand({ TargetGroupArn: str(p, 'targetGroupArn'), Targets: [{ Id: str(p, 'targetId'), Port: optStr(p, 'port') ? num(p, 'port') : undefined }] }),
      );
      return { ok: true };
    },
    async createLoadBalancer(ctx, p) {
      return (
        await ctx.client(ElasticLoadBalancingV2Client).send(
          new CreateLoadBalancerCommand({ Name: str(p, 'name'), Subnets: strList(p, 'subnets'), Scheme: (optStr(p, 'scheme') as 'internal' | 'internet-facing') ?? 'internal', Type: 'application' }),
        )
      ).LoadBalancers?.[0];
    },
    async deleteLoadBalancer(ctx, p) {
      await ctx.client(ElasticLoadBalancingV2Client).send(new DeleteLoadBalancerCommand({ LoadBalancerArn: str(p, 'arn') }));
      return { deleted: true };
    },
    async createListener(ctx, p) {
      return (
        await ctx.client(ElasticLoadBalancingV2Client).send(
          new CreateListenerCommand({
            LoadBalancerArn: str(p, 'arn'),
            Protocol: 'HTTP',
            Port: num(p, 'port', 80),
            DefaultActions: [{ Type: 'forward', TargetGroupArn: str(p, 'targetGroupArn') }],
          }),
        )
      ).Listeners?.[0];
    },
    async deleteListener(ctx, p) {
      await ctx.client(ElasticLoadBalancingV2Client).send(new DeleteListenerCommand({ ListenerArn: str(p, 'listenerArn') }));
      return { deleted: true };
    },
  },
};
