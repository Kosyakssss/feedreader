import type { IconName } from '../../lib/icons.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, className = 'ui-icon'): SVGSVGElement {
  const node = document.createElementNS(SVG_NAMESPACE, 'svg');
  node.setAttribute('class', className);
  node.setAttribute('viewBox', '0 0 20 20');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `#icon-${name}`);
  node.append(use);
  return node;
}

export function setIcon(root: ParentNode, name: IconName): void {
  root.querySelector<SVGUseElement>('use')?.setAttribute('href', `#icon-${name}`);
}

export function appendTrailingIcon(root: HTMLElement, name: IconName): void {
  root.append(icon(name, 'ui-icon button-icon'));
}
