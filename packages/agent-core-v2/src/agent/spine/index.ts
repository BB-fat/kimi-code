/**
 * `spine` domain (L4) — public surface of the model-driven Spine task tree.
 *
 * Re-exporting each module executes its import-time registration
 * (`registerScopedService` for the service, `registerTool` for the four control
 * tools), so importing this index is what wires spine into an Agent scope.
 */

export * from './flag';
export * from './instructions';
export * from './spine';
export * from './spineOps';
export * from './spineService';
export * from './spineTree';
export * from './tools/controlResult';
export * from './tools/descriptions';
export * from './tools/spine-close';
export * from './tools/spine-next';
export * from './tools/spine-open';
export * from './tools/spine-tree';
