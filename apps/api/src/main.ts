import { loadConfig } from "./config";
import { buildServer } from "./server";

const config = loadConfig();
const server = await buildServer({ config });
await server.app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.app.log.info(`${signal}: shutting down`);
    void server.close().then(() => process.exit(0));
  });
}
