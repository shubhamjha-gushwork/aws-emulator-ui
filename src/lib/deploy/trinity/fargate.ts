/** Valid Fargate task-level CPU (units) → allowed memory (MiB). */
const FARGATE_MEMORY: Record<number, number[]> = {
  256: [512, 1024, 2048],
  512: [1024, 2048, 3072, 4096],
  1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  2048: [4096, 5120, 6144, 7168, 8192, 9216, 10240, 11264, 12288, 13312, 14336, 15360, 16384],
  4096: Array.from({ length: 23 }, (_, i) => 8192 + i * 1024), // 8192–30720
  8192: Array.from({ length: 12 }, (_, i) => 16384 + i * 4096), // 16384–61440
  16384: Array.from({ length: 12 }, (_, i) => 32768 + i * 8192), // 32768–122880
};

const CPUS = Object.keys(FARGATE_MEMORY).map(Number).sort((a, b) => a - b);

/** Snap a requested cpu/memory pair to the next valid Fargate combination (never smaller than requested memory). */
export function fitFargateResources(cpu: number, memory: number): { cpu: number; memory: number; adjusted: boolean } {
  const reqCpu = Number.isFinite(cpu) && cpu > 0 ? cpu : 256;
  const reqMem = Number.isFinite(memory) && memory > 0 ? memory : 512;
  const tryCpu = (c: number): number | undefined => {
    const allowed = FARGATE_MEMORY[c];
    if (!allowed) return undefined;
    return allowed.find((m) => m >= reqMem);
  };
  const exactCpu = CPUS.find((c) => c >= reqCpu) ?? CPUS[CPUS.length - 1];
  let chosenCpu = exactCpu;
  let chosenMem = tryCpu(chosenCpu);
  if (chosenMem === undefined) {
    for (const c of CPUS) {
      if (c < reqCpu) continue;
      const m = tryCpu(c);
      if (m !== undefined) {
        chosenCpu = c;
        chosenMem = m;
        break;
      }
    }
  }
  if (chosenMem === undefined) {
    chosenCpu = 16384;
    chosenMem = FARGATE_MEMORY[16384][FARGATE_MEMORY[16384].length - 1];
  }
  return { cpu: chosenCpu, memory: chosenMem, adjusted: chosenCpu !== reqCpu || chosenMem !== reqMem };
}
