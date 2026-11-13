// Chrome on Android tells the page about its keyboard only once the keyboard
// is all the way up, so search would wait behind it and then jump. Its
// VirtualKeyboard API says how tall the keyboard will be as it starts to
// rise, and lets search move with it instead. Only over HTTPS, or on this
// machine; elsewhere search goes by what the viewport says, as Safari and
// Firefox do.
type VirtualKeyboard = EventTarget & { overlaysContent: boolean; boundingRect: DOMRect };

export function virtualKeyboard(): VirtualKeyboard | undefined {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard;
}

// While search is open the keyboard lays over the page, rather than Chrome
// shrinking the page and sliding it to keep the field in view; search places
// itself above the keyboard. Elsewhere the page makes room for the keyboard,
// so the fields in a page's own writing stay in view.
export function keyboardOverPage(over: boolean): void {
  const keyboard = virtualKeyboard();
  if (keyboard) keyboard.overlaysContent = over;
}
