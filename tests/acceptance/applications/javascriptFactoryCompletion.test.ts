import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { isNativeError } from "node:util/types";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const scenarios = [
  { name: "control", guard: "", candidate: true },
  { name: "false", guard: "if (false) return;", candidate: true },
  { name: "unknown", guard: "if (flag) return;", candidate: true },
  { name: "block", guard: "{ if (flag) return; }", candidate: true },
  {
    name: "nested-function",
    guard: "function unused() { return; }",
    candidate: true,
  },
  { name: "true", guard: "if (true) return;", candidate: false },
  { name: "return", guard: "return;", candidate: false },
  { name: "both", guard: "if (flag) return; else return;", candidate: false },
  { name: "throw", guard: "throw new Error('stop');", candidate: false },
  { name: "labeled-exit", guard: "exit: { return; }", candidate: false },
  { name: "with-exit", guard: "with ({}) { return; }", candidate: false },
  {
    name: "export-after-exit",
    guard: "return;",
    candidate: false,
    bindingFirst: true,
  },
] as const;

const factorySource = (guard: string, bindingFirst: boolean) => {
  const binding = "const electron = load(2);";
  return `(() => {
    const modules = {
      2(module) { module.exports = require("electron"); },
      5(module,exports,load) {
        ${bindingFirst ? binding : ""}
        ${guard}
        ${bindingFirst ? "" : binding}
        exports.events = { addListener(channel,handler) {
          return electron.ipcMain.addListener(channel,handler);
        }};
      },
      9(module,exports,load) {
        const helper = load(5);
        helper.events.addListener("test:copy", () => {});
      }
    };
    function load(id) { const m={exports:{}}; modules[id].call(m.exports,m,m.exports,load); return m.exports; }
    load(9);
  })();`;
};

const runtimeChannels = (source: string, flag: boolean) => {
  const channels: string[] = [];
  try {
    // Only this authored fixture executes. REA reads the same bytes as inert
    // source; the stub does not establish real Electron runtime behavior.
    runInNewContext(
      source,
      {
        flag,
        require: (name: string) => {
          if (name !== "electron") throw new Error(`Unexpected module ${name}`);
          return {
            ipcMain: {
              addListener: (channel: string) => channels.push(channel),
            },
          };
        },
      },
      { timeout: 1_000 },
    );
  } catch (error) {
    // A skipped export makes the caller throw before it registers a handler.
    if (
      !isNativeError(error) ||
      channels.length !== 0 ||
      !(
        error.message === "stop" ||
        (error.name === "TypeError" && error.message.includes("addListener"))
      )
    )
      throw error;
  }
  return channels;
};

type Application = ReturnType<
  typeof javascriptApplicationAnalysisResultSchema.parse
>;

const verifyApplication = (
  result: Application,
  candidate: boolean,
  guarded: boolean,
) => {
  expect(result.statistics.parse_failures).toBe(0);
  expect(result.summary.ipc.literal_channels).toBe(
    candidate && !guarded ? 1 : 0,
  );
  const handlers = result.graph.nodes.filter(
    (node) =>
      node.identity.strategy === "artifact-local-key" &&
      node.identity.namespace === "electron-ipc-handler" &&
      node.identity.key.includes("main:on:test:copy:"),
  );
  expect(handlers).toHaveLength(candidate && !guarded ? 1 : 0);
  for (const handler of handlers) {
    expect(handler.observations[0]?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
      location: { available: true, value: { source: "main.js" } },
      coverage: { status: "partial" },
    });
  }
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: false,
  });
  if (guarded) {
    const paths = result.graph.nodes
      .flatMap((node) => node.observations)
      .filter(
        (observation) =>
          observation.properties.terminal === "electron.ipcMain.addListener" &&
          observation.properties.channel === "test:copy",
      );
    expect(paths.map((observation) => observation.properties)).toContainEqual(
      expect.objectContaining({
        resolution: "candidate",
        conditions: expect.arrayContaining([
          expect.objectContaining({ expression: "!(flag)" }),
        ]),
      }),
    );
    expect(paths[0]?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
      location: { available: true, value: { source: "main.js" } },
    });
  }
};

cliTest(
  "retains guarded factory fallthrough through CLI and real stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-factory-completion-");
    const { call } = await connectLocalToolsMcp();
    const contract = toolContract("analyze_javascript_application");
    for (const scenario of scenarios) {
      const source = factorySource(scenario.guard, "bindingFirst" in scenario);
      const directory = join(root, scenario.name);
      await mkdir(directory);
      await writeFile(join(directory, "main.js"), source);
      const runtime = [false, true].map((flag) =>
        runtimeChannels(source, flag),
      );
      const hasRuntimePath = runtime.some((channels) =>
        channels.includes("test:copy"),
      );
      expect(hasRuntimePath, scenario.name).toBe(scenario.candidate);
      if (["unknown", "block"].includes(scenario.name))
        expect(runtime).toEqual([["test:copy"], []]);
      const response = await call("analyze_javascript_application", {
        input_path: directory,
        format: "directory",
      });
      expect(response.isError, scenario.name).not.toBe(true);
      const evidence = contract.outputSchema.parse(response.structuredContent);
      verifyApplication(
        javascriptApplicationAnalysisResultSchema.parse(
          evidence.normalized_result,
        ),
        scenario.candidate,
        ["unknown", "block"].includes(scenario.name),
      );
      if (["control", "false", "unknown"].includes(scenario.name)) {
        const analyzed = await cli.run({
          arguments: [
            "analyze-javascript-application",
            directory,
            "--artifact-format",
            "directory",
            "--json",
          ],
        });
        expect(analyzed.exitCode, analyzed.stderr).toBe(0);
        expect(contract.outputSchema.parse(analyzed.json).evidence_id).toBe(
          evidence.evidence_id,
        );
      }
    }
  },
  60_000,
);
