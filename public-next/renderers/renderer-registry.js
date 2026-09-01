export class RendererRegistry {
  #renderers = new Map();
  #handles = new WeakMap();

  register(renderer) {
    if (!renderer?.id || typeof renderer.render !== 'function') throw new TypeError('Invalid renderer');
    this.#renderers.set(renderer.id, renderer);
    return this;
  }

  render(element, spec) {
    this.destroy(element);
    const renderer = spec.engine ? this.#renderers.get(spec.engine) : [...this.#renderers.values()].find((item) => item.supports(spec));
    if (!renderer) throw new Error(`No renderer supports ${spec.kind}`);
    const handle = renderer.render(element, spec);
    this.#handles.set(element, handle);
    return handle;
  }

  destroy(element) {
    this.#handles.get(element)?.destroy?.();
    this.#handles.delete(element);
    element.replaceChildren();
  }
}

