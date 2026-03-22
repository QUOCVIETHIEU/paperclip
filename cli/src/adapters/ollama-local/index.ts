import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { printProcessStdoutEvent } from "../process/format-event.js";

export const ollamaLocalCLIAdapter: CLIAdapterModule = {
  type: "ollama_local",
  formatStdoutEvent: printProcessStdoutEvent,
};
