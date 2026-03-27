type OverlayLayerId = symbol;

const overlayStack: OverlayLayerId[] = [];

export function createOverlayLayerId(label: string): OverlayLayerId {
  return Symbol(label);
}

export function pushOverlayLayer(id: OverlayLayerId): () => void {
  overlayStack.push(id);
  return () => {
    const index = overlayStack.lastIndexOf(id);
    if (index >= 0) {
      overlayStack.splice(index, 1);
    }
  };
}

export function isTopOverlayLayer(id: OverlayLayerId): boolean {
  return overlayStack[overlayStack.length - 1] === id;
}
