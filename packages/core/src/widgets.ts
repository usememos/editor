// Widgets: app UI shown between blocks and never saved, such as an upload
// placeholder with progress. A widget sits after a block and moves with it.

export interface WidgetRender {
  /** Fills the widget's element. May return a cleanup function, called before the next render and on removal. */
  (element: HTMLElement): void | (() => void);
}

export interface Widget {
  /** The element the widget renders into. It is not editable text. */
  readonly element: HTMLElement;
  /** The block the widget is shown after. */
  readonly blockId: string;
  readonly isRemoved: boolean;
  /** Renders again, with a new render function if given. */
  update(render?: WidgetRender): void;
  remove(): void;
}

export class WidgetImpl implements Widget {
  blockId: string;
  isRemoved = false;
  private cleanup: (() => void) | null = null;

  constructor(
    readonly element: HTMLElement,
    blockId: string,
    private render: WidgetRender,
    private readonly onRemove: (widget: WidgetImpl) => void,
  ) {
    this.blockId = blockId;
    this.paint();
  }

  update(render?: WidgetRender): void {
    if (this.isRemoved) return;
    if (render) this.render = render;
    this.paint();
  }

  remove(): void {
    if (this.isRemoved) return;
    this.isRemoved = true;
    this.cleanup?.();
    this.cleanup = null;
    this.element.remove();
    this.onRemove(this);
  }

  private paint(): void {
    this.cleanup?.();
    this.element.replaceChildren();
    const result = this.render(this.element);
    this.cleanup = typeof result === 'function' ? result : null;
  }
}
