declare global {
  namespace App {
    interface Platform {
      server: Bun.Server<undefined>;
      request: Request;
    }
  }
}
export {};
