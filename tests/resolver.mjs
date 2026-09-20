/**
 * Lets `node --test` load the app's own modules unchanged.
 *
 * The app is built by Next, which resolves the `@/*` alias from tsconfig and
 * fills in extensions. Node does neither, so without this the test suite
 * could only ever reach modules written in a style nothing else in the
 * codebase uses. Resolving here keeps the tests pointed at the real files.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  const target = specifier.startsWith("@/")
    ? pathToFileURL(path.join(projectRoot, specifier.slice(2))).href
    : specifier;

  try {
    return await nextResolve(target, context);
  } catch (error) {
    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(target + extension, context);
      } catch {
        // Not this extension; fall through to the original failure.
      }
    }
    throw error;
  }
}
