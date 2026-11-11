/**
 * A dependency-free login button (app_sdk.md §9a.4). It only navigates to the
 * site's own start endpoint; requests are created and signed server-side.
 * Safe to import in any environment; it touches the DOM only when called.
 */
export function mountLoginButton(element: HTMLElement, options: { startPath: string; label?: string }): HTMLButtonElement {
  const button = element.ownerDocument.createElement('button');
  button.type = 'button';
  button.textContent = options.label ?? 'Log in with a membership card';
  button.addEventListener('click', () => {
    element.ownerDocument.defaultView?.location.assign(options.startPath);
  });
  element.appendChild(button);
  return button;
}
