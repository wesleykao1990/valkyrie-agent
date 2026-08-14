declare module "@bastani/workflows" {
  export function workflow<T extends { run: (ctx: any) => any }>(definition: T): T;
  export function keepContext(value: string): string;
}
