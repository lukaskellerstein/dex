# Quickstart: Structured Outputs Implementation

## Prerequisites

1. Upgrade the SDK:

   ```bash
   npm install @anthropic-ai/claude-agent-sdk@^0.1.45
   ```

2. Verify the types exist:

   ```bash
   grep -r "outputFormat" node_modules/@anthropic-ai/claude-agent-sdk/
   grep -r "structured_output" node_modules/@anthropic-ai/claude-agent-sdk/
   ```

## Implementation Order

Follow the phases in `plan.md` strictly — each phase builds on the previous:

1. **Phase 1**: SDK upgrade + extend `runStage` with `outputFormat` support
2. **Phase 2**: Create `manifest.ts` module
3. **Phase 3**: Manifest extraction + deterministic gap analysis
4. **Phase 4**: Fix specify prompt + manifest-specDir linking
5. **Phase 5**: Structured verify + fix-reverify loop
6. **Phase 6**: Structured learnings + synthesis confirmation + lifecycle updates

## Key Files to Modify

| File | Primary Change |
|------|---------------|
| `package.json` | SDK version bump |
| `src/core/types.ts` | New types and event definitions |
| `src/core/manifest.ts` | **NEW** — entire manifest module |
| `src/core/orchestrator.ts` | `runStage` extension, manifest integration, structured verify/learnings |
| `src/core/prompts.ts` | New prompt builders, fix existing prompts, schema constants |
| `src/core/parser.ts` | Remove `parseGapAnalysisResult` and `GAP_DECISION_RE` |
| `src/core/state.ts` | `FeatureArtifacts.status` updates, manifest reconciliation |

## Verification Checklist

After each phase, verify:
- [ ] `npx tsc --noEmit` passes
- [ ] Existing loop behavior unchanged (for phases 1-2)
- [ ] New behavior works (for phases 3-6)

End-to-end verification:
- [ ] Run loop on multi-feature project for 3+ cycles
- [ ] Verify deterministic feature selection
- [ ] Verify structured verify detects a known defect
- [ ] Verify fix-reverify loop triggers and terminates
- [ ] Verify learnings deduplication
- [ ] Verify manifest drift warning
- [ ] Simulate crash and verify recovery
