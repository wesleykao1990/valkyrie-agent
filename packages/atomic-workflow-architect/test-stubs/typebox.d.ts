declare module "typebox" {
  export const Type: {
    String(options?: any): any;
    Boolean(options?: any): any;
    Number(options?: any): any;
    Array(item: any, options?: any): any;
    Optional(item: any): any;
    Object(shape: any, options?: any): any;
  };
}
