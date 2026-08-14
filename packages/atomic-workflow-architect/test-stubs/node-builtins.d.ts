declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
}
declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}
declare module "node:fs/promises" {
  export function lstat(path: string): Promise<any>;
  export function readFile(path: string, encoding?: string): Promise<any>;
  export function realpath(path: string): Promise<string>;
  export function writeFile(path: string, data: any, options?: any): Promise<void>;
}
declare const process: {
  cwd(): string;
};
