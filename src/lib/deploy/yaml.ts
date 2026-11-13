import { load, dump, Type, DEFAULT_SCHEMA } from 'js-yaml';

function typ(name: string, kind: 'scalar' | 'sequence' | 'mapping', construct: (data: unknown) => unknown) {
  return new Type(`!${name}`, { kind, construct });
}

const CFN: Type[] = [
  typ('Ref', 'scalar', (d) => ({ Ref: d })),
  typ('GetAtt', 'scalar', (d) => ({ 'Fn::GetAtt': String(d).split('.') })),
  typ('GetAtt', 'sequence', (d) => ({ 'Fn::GetAtt': d })),
  typ('Sub', 'scalar', (d) => ({ 'Fn::Sub': d })),
  typ('Sub', 'sequence', (d) => ({ 'Fn::Sub': d })),
  typ('Join', 'sequence', (d) => ({ 'Fn::Join': d })),
  typ('Equals', 'sequence', (d) => ({ 'Fn::Equals': d })),
  typ('If', 'sequence', (d) => ({ 'Fn::If': d })),
  typ('Not', 'sequence', (d) => ({ 'Fn::Not': d })),
  typ('And', 'sequence', (d) => ({ 'Fn::And': d })),
  typ('Or', 'sequence', (d) => ({ 'Fn::Or': d })),
  typ('Select', 'sequence', (d) => ({ 'Fn::Select': d })),
  typ('Split', 'sequence', (d) => ({ 'Fn::Split': d })),
  typ('FindInMap', 'sequence', (d) => ({ 'Fn::FindInMap': d })),
  typ('ImportValue', 'scalar', (d) => ({ 'Fn::ImportValue': d })),
  typ('Condition', 'scalar', (d) => ({ Condition: d })),
  typ('Base64', 'scalar', (d) => ({ 'Fn::Base64': d })),
  typ('Cidr', 'sequence', (d) => ({ 'Fn::Cidr': d })),
  typ('GetAZs', 'scalar', (d) => ({ 'Fn::GetAZs': d })),
  typ('Transform', 'mapping', (d) => ({ 'Fn::Transform': d })),
];

const SCHEMA = DEFAULT_SCHEMA.extend(CFN);

export function loadYaml(text: string): unknown {
  return load(text, { schema: SCHEMA }) ?? {};
}

export function dumpYaml(doc: unknown): string {
  return dump(doc, { schema: SCHEMA, lineWidth: 120, noRefs: true });
}
