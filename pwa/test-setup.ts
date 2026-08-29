import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

GlobalRegistrator.register();

// Note: testing-library's cleanup() is incompatible with happy-dom's global registration
// in this context and causes "document is not defined" errors. Clearing DOM via innerHTML
// achieves the primary goal (preventing accumulated render state between tests) while
// maintaining compatibility. React effect cleanup would require a different test setup approach.
afterEach(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
});
