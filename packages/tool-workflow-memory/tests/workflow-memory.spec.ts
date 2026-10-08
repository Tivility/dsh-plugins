/**
 * Synthetic Test Suite for @tivility/dsh-tool-workflow-memory
 */

import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply as applyWorkflowMemory, PtcWorkflowEngine } from '../src/index.js';

describe('tool-workflow-memory', () => {
  it('registers workflow tool with documentation for globalMemory', () => {
    let registeredTool: any;
    const ctx = new Context();
    ctx.provide('tools');
    (ctx as any).tools = {
      register: (tool: any) => {
        registeredTool = tool;
        return () => { registeredTool = undefined; };
      },
      get: () => registeredTool,
    };
    ctx.provide('workflowEngine');
    (ctx as any).workflowEngine = {
      start: () => {},
    };
    ctx.provide('systemPrompt');
    (ctx as any).systemPrompt = {
      section: () => {},
      getSectionOrder: () => 100,
    };

    applyWorkflowMemory(ctx, { enableRunInBackground: true });

    expect(registeredTool).toBeDefined();
    // defineTool returned object
    const desc = registeredTool.description;
    expect(desc).toContain('`globalMemory` (boolean, default false');
  });

  it('PtcWorkflowEngine starts child with globalMemory in agentOptions', async () => {
    let capturedStartRequest: any;
    const ctx = new Context();
    ctx.provide('subagents');
    (ctx as any).subagents = {
      getProvider: () => ({ name: 'spawn' }),
      start: async (_provider: string, request: any) => {
        capturedStartRequest = request;
        return {
          id: 'child-synthetic-wf-1',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: 'synthetic child result' }],
          }),
          dispose: async () => {},
        };
      },
    };
    ctx.provide('ptcRuntime');
    (ctx as any).ptcRuntime = {
      language: 'typescript',
      resolve: (spec: any) => spec,
      run: async (spec: any) => {
        const binding = spec.bindings.find((b: any) => b.global === 'workflowHost')?.functions;
        if (binding) {
          // Simulate guest execution
          await binding.begin();
          const child = await binding.startChild({
            prompt: 'Test prompt from workflow',
            globalMemory: true,
          });
          const result = await binding.childResult({ callId: child.callId });
          await binding.disposeChild({ callId: child.callId });
          return {
            value: {
              value: { ok: true, childResult: result },
              stopReason: 'completed',
              agentsStarted: 1,
            },
          };
        }
        return { value: { value: null, stopReason: 'completed', agentsStarted: 0 } };
      },
    };
    ctx.provide('sandboxPolicy');
    (ctx as any).sandboxPolicy = {
      resolve: () => ({ workspaceRoot: '/tmp' }),
    };

    const engine = new PtcWorkflowEngine(ctx, { provider: 'spawn' });
    const parentAgent: any = {
      id: 'parent-synth-wf',
      session: {
        header: { origin: 'user' },
        append: () => true,
      },
    };

    const run = engine.start({
      meta: { name: 'synthetic-test-workflow', description: 'Testing global memory forwarding' },
      script: 'return 42;',
      parent: parentAgent,
    });

    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    expect(capturedStartRequest).toBeDefined();
    expect(capturedStartRequest.agentOptions.globalMemory).toBe(true);
    await run.dispose();
  });
});
