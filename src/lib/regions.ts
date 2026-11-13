/** Regions offered in the region picker (nav bar and Settings), in display order. Edit this list to change them. */
export const REGIONS: { code: string; name: string; group: string }[] = [
  { code: 'ap-south-1', name: 'Asia Pacific (Mumbai)', group: 'Asia Pacific' },
  { code: 'ap-southeast-1', name: 'Asia Pacific (Singapore)', group: 'Asia Pacific' },
  { code: 'us-east-1', name: 'US East (N. Virginia)', group: 'United States' },
  { code: 'us-east-2', name: 'US East (Ohio)', group: 'United States' },
  { code: 'us-west-2', name: 'US West (Oregon)', group: 'United States' },
  { code: 'eu-west-1', name: 'Europe (Ireland)', group: 'Europe' },
  { code: 'eu-central-1', name: 'Europe (Frankfurt)', group: 'Europe' },
];

export const regionName = (code: string | undefined) => REGIONS.find((r) => r.code === code)?.name ?? code ?? '';
