export type RendererBootKind = 'projection' | 'legacy' | 'projection-adopt' | 'adopt'

export interface RendererBootActions {
  /** Projection mode: start presentation only; the host owns game rules/clock. */
  startProjectionPresentation(): void
  /** Legacy mode: resume renderer-owned tasks and the minute simulation. */
  startLegacy(): void
  /** Projection mode without a pet: adopt via pet.adopt, then presentation only. */
  startProjectionAdoption(): void
  /** Legacy mode without a pet: renderer-owned SaveData adoption. */
  startAdoption(): void
}

/** Chooses exactly one renderer authority boot path; never starts both. */
export function bootRenderer(
  runtimeProjectionMode: boolean,
  havePet: boolean,
  actions: RendererBootActions,
): RendererBootKind {
  if (havePet === false) {
    if (runtimeProjectionMode) {
      actions.startProjectionAdoption()
      return 'projection-adopt'
    }
    actions.startAdoption()
    return 'adopt'
  }
  if (runtimeProjectionMode) {
    actions.startProjectionPresentation()
    return 'projection'
  }
  actions.startLegacy()
  return 'legacy'
}

/** LAN visit actions are not command-converted in C6a, so runtime mode must not mount them. */
export function mountLanVisits(runtimeProjectionMode: boolean): boolean {
  return runtimeProjectionMode === false
}
