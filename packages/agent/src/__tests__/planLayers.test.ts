import { describe, it, expect } from "vitest";
import { computePendingPlanLayers, computePlanLayers, formatLayerSummary } from "../planLayers.js";

describe("plan layer parsing", () => {
  it("computes parallel layer for dependency fan-out", () => {
    const plan = `
### Phase 1: Setup
- [ ] **Task 1: Scaffold package**

### Phase 2: Build
- [ ] **Task 2: Build component** (depends on 1)
- [ ] **Task 3: Add styles** (depends on 1)

### Phase 3: Verify
- [ ] **Task 4: Verify** (depends on 2, 3)
`;
    const { layers } = computePlanLayers(plan);
    expect(layers).toEqual([[1], [2, 3], [4]]);
  });

  it("uses implicit phase dependencies when depends-on is omitted", () => {
    const plan = `
### Phase 1
- [ ] **Task 1: one**
- [ ] **Task 2: two**

### Phase 2
- [ ] **Task 3: three**
`;
    const { layers } = computePlanLayers(plan);
    expect(layers).toEqual([[1, 2], [3]]);
  });

  it("parses heading-style tasks with Depends on lines", () => {
    const plan = `
### Task 1: Init
**Depends on:** nothing

### Task 2: UI
**Depends on:** Task 1

### Task 3: CSS
**Depends on:** Task 1
`;
    const { layers } = computePlanLayers(plan);
    expect(layers).toEqual([[1], [2, 3]]);
  });

  it("formats summary for prompt injection", () => {
    const text = formatLayerSummary([[1], [2, 3], [4]]);
    expect(text).toContain("Layer 2 (parallel): tasks 2, 3");
  });

  it("parses numbered checklist tasks in `1. [ ]` format", () => {
    const plan = `
## Fix Steps
1. [ ] Remove footer html
2. [x] Remove footer css
3. [ ] Remove footer js (depends on 1)
`;
    const { layers } = computePendingPlanLayers(plan);
    expect(layers).toEqual([[1], [3]]);
  });

  it("parses numbered tasks without checkboxes as pending", () => {
    const plan = `
## Steps
1. Create endpoint
2) Add tests
3. Verify integration
`;
    const { layers } = computePendingPlanLayers(plan);
    expect(layers).toEqual([[1, 2, 3]]);
  });
});
