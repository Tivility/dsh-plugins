/**
 * Synthetic Test Suite for @tivility/dsh-tool-subagent-memory
 */

import { describe, it, expect } from 'vitest';
import { apply as applySubagentMemory } from '../src/index.js';

interface Tool {
  name: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  output: { schema: object; render(args: unknown, value: any): { type: string; text: string }[] };
  isConcurrencySafe(args: unknown): boolean;
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>;
}

interface StartCall {
  provider: string;
  request: Record<string, unknown>;
}

interface Bench {
  tool: Tool;
  starts: StartCall[];
  continuables: StartCall[];
  promptText(): string;
}

function createBench(options: {
  config?: Record<string, unknown>;
} = {}): Bench {
  const starts: StartCall[] = [];
  const continuables: StartCall[] = [];
  let tool: Tool | undefined;
  let section: { text(context: unknown): string } | undefined;

  const provider = {
    name: 'spawn',
    capabilities: { depthLimit: true, agentOptions: true },
    inheritsParentContext: false,
    prepareContinuable: () => {},
  };

  const registeredProjections: any[] = [];

  const ctx = {
    tools: {
      register(definition: Tool) {
        tool = definition;
        return () => { tool = undefined; };
      },
      get: () => tool,
    },
    subagents: {
      getProvider: (nameString: string) => (nameString === 'spawn' ? provider : undefined),
      start(providerName: string, request: Record<string, unknown>) {
        starts.push({ provider: providerName, request });
        return Promise.resolve({
          id: 'run-synth-1',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: 'synthetic completed output' }],
          }),
          dispose: () => {},
        });
      },
      startContinuable(request: { provider: string; request: Record<string, unknown> }) {
        continuables.push({ provider: request.provider, request: request.request });
        return Promise.resolve({ childId: 'child-synth-1' });
      },
    },
    systemPrompt: {
      section(spec: { text(context: unknown): string }) {
        section = spec;
        return () => {};
      },
      getSectionOrder: () => 100,
    },
    sessionProjections: {
      register(proj: any) {
        registeredProjections.push(proj);
      },
      stateOf: () => null,
    },
    get: (nameString: string) => {
      if (nameString === 'jobs') {
        return {
          start: () => 'job-synth-1',
        };
      }
      return undefined;
    },
    on: () => () => {},
    effect(run: () => unknown) {
      run();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} },
  };

  applySubagentMemory(ctx as any, { provider: 'spawn', backgroundMode: 'continuable', ...options.config } as any);
  if (tool === undefined) throw new Error('no tool registered');
  return {
    tool,
    starts,
    continuables,
    promptText: () => section?.text({ scope: {} }) ?? '',
  };
}

describe('tool-subagent-memory', () => {
  it('registers subagent tool with global_memory parameter', () => {
    const { tool } = createBench();
    expect(tool.name).toBe('subagent');
    const props = (tool.parameters as any).properties;
    expect(props.global_memory).toBeDefined();
    expect(props.global_memory.type).toBe('boolean');
    expect(props.global_memory.description).toBe("include the user's global memory in the child's context");
  });

  it('passes globalMemory option correctly to child agentOptions', async () => {
    const b = createBench();

    const mockAgent = {
      id: 'parent-synth-agent',
      session: {
        header: { origin: 'user' },
        requestHeader: () => undefined,
        firstLiveSeq: 0,
        eventAt: () => null,
      },
      options: {
        provider: 'synth-provider',
        model: 'synth-model',
      },
    };

    // 1. global_memory = true (foreground)
    const resultTrue = await b.tool.execute(
      {
        description: 'Test subagent delegation',
        prompt: 'Run task with memory',
        global_memory: true,
        run_in_background: false,
      },
      { agent: mockAgent, signal: new AbortController().signal },
    );

    expect(resultTrue.kind).toBe('foreground');
    expect(b.starts.length).toBe(1);
    expect((b.starts[0]?.request as any).agentOptions.globalMemory).toBe(true);

    // 2. global_memory = false (background continuable)
    const resultFalse = await b.tool.execute(
      {
        description: 'Test subagent delegation',
        prompt: 'Run task without memory',
        global_memory: false,
        run_in_background: true,
      },
      { agent: mockAgent, signal: new AbortController().signal },
    );

    expect(resultFalse.kind).toBe('continuable');
    expect(b.continuables.length).toBe(1);
    expect((b.continuables[0]?.request as any).agentOptions.globalMemory).toBe(false);

    // 3. global_memory omitted (background continuable default)
    await b.tool.execute(
      {
        description: 'Test subagent delegation',
        prompt: 'Run task with default memory',
      },
      { agent: mockAgent, signal: new AbortController().signal },
    );

    expect(b.continuables.length).toBe(2);
    expect((b.continuables[1]?.request as any).agentOptions.globalMemory).toBe(false);
  });
});
