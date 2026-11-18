#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { classifyToolSemantics, generateSwitchyardRoutesToml, runOcrDiffReview, selectCrossFamilyReviewer, SwitchyardStageRouter, verifySnapshotTests, } from '../core/index.js';
const MCP_TOOLS = [
    {
        name: 'switchyard_evaluate',
        description: 'Record a tool outcome into NVIDIA NeMo Switchyard StageRouter (with tool_semantics) or infer card modelTier.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                toolName: { type: 'string' },
                argsSummary: { type: 'string' },
                isError: { type: 'boolean' },
                outputPreview: { type: 'string' },
                cardTitle: { type: 'string' },
                cardDescription: { type: 'string' },
            },
            required: ['toolName', 'isError'],
        },
    },
    {
        name: 'review_worktree_gate',
        description: 'Run snapshot test verification + OCR review + cross-family reviewer pairing on a candidate repo dir.',
        inputSchema: {
            type: 'object',
            properties: {
                testCommand: { type: 'string' },
                baseRef: { type: 'string' },
                authorProvider: { type: 'string' },
                runOcr: { type: 'boolean' },
            },
            required: ['testCommand'],
        },
    },
    {
        name: 'export_switchyard_config',
        description: 'Export NVIDIA NeMo Switchyard routes.toml configuration matching ns-team routing policy.',
        inputSchema: { type: 'object', properties: {} },
    },
];
class RpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export async function startMcpServer(workspaceRoot = process.cwd()) {
    const router = new SwitchyardStageRouter();
    const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const handleRequest = async (req) => {
        const id = req.id ?? null;
        try {
            if (typeof req.method !== 'string' || !req.method) {
                throw new RpcError(-32600, 'invalid JSON-RPC request: missing method');
            }
            if (req.method === 'initialize') {
                write({
                    jsonrpc: '2.0',
                    id,
                    result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ns-team', version: '0.1.0' } },
                });
            }
            else if (req.method === 'tools/list') {
                write({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
            }
            else if (req.method === 'tools/call') {
                const name = String(req.params?.name ?? '');
                const args = (req.params?.arguments ?? {});
                if (!args || typeof args !== 'object' || Array.isArray(args))
                    throw new RpcError(-32602, 'arguments must be an object');
                let result;
                if (name === 'switchyard_evaluate') {
                    const outcome = router.recordToolOutcome({
                        sessionId: String(args.sessionId ?? 'default'),
                        toolName: String(args.toolName ?? ''),
                        argsSummary: String(args.argsSummary ?? ''),
                        isError: Boolean(args.isError),
                        outputPreview: typeof args.outputPreview === 'string' ? args.outputPreview : undefined,
                    });
                    result = {
                        ...outcome,
                        semantics: classifyToolSemantics(String(args.toolName ?? ''), String(args.argsSummary ?? '')),
                        ...(typeof args.cardTitle === 'string'
                            ? {
                                inferredCardTier: router.inferCardTier({
                                    title: args.cardTitle,
                                    description: typeof args.cardDescription === 'string' ? args.cardDescription : undefined,
                                }),
                            }
                            : {}),
                    };
                }
                else if (name === 'review_worktree_gate') {
                    const skipOcr = args.runOcr === false;
                    const [snapshot, ocr] = await Promise.all([
                        Promise.resolve().then(() => verifySnapshotTests(workspaceRoot, String(args.testCommand ?? 'npm test'))),
                        skipOcr
                            ? Promise.resolve({ ran: false, passed: true, blockingCount: 0, findings: [] })
                            : Promise.resolve().then(() => runOcrDiffReview(workspaceRoot, String(args.baseRef ?? 'HEAD~1'))),
                    ]);
                    const reviewer = selectCrossFamilyReviewer(String(args.authorProvider ?? 'google-antigravity'));
                    result = { passed: snapshot.passed && snapshot.worktreeIntact && ocr.passed, snapshot, ocr, reviewer };
                }
                else if (name === 'export_switchyard_config') {
                    result = { routesToml: generateSwitchyardRoutesToml() };
                }
                else {
                    throw new RpcError(-32601, `unknown tool: ${name}`);
                }
                write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
            }
            else {
                throw new RpcError(-32601, `method not found: ${req.method}`);
            }
        }
        catch (error) {
            write({
                jsonrpc: '2.0',
                id,
                error: { code: error instanceof RpcError ? error.code : -32000, message: error instanceof Error ? error.message : String(error) },
            });
        }
    };
    for await (const line of rl) {
        if (!line.trim())
            continue;
        let req;
        try {
            req = JSON.parse(line);
        }
        catch {
            write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            continue;
        }
        if (!req || typeof req !== 'object' || Array.isArray(req)) {
            write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
            continue;
        }
        if (req.id === undefined)
            continue;
        void handleRequest(req);
    }
}
const isEntrypoint = (() => {
    try {
        return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    }
    catch {
        return false;
    }
})();
if (isEntrypoint) {
    await startMcpServer(process.argv[2] ?? process.cwd());
}
//# sourceMappingURL=server.js.map