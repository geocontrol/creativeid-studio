import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStudioServer } from "./server.js";

export * from "./schema.js";
export * from "./transformers.js";
export * from "./store.js";
export * from "./adapters/index.js";
export * from "./server.js";

const isMain = (() => {
  try {
    const currentFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return currentFile === entryFile;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number(process.env.PORT || 3400);
  const server = createStudioServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `CreativeID Studio local-first server running at http://localhost:${port}`
    );
  });
}
