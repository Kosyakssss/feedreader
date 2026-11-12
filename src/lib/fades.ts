// Names in a long list dissolve at an end only while there is more to scroll
// to past it, over at most one row, and a list that fits doesn't fade at all.
// Worked out here rather than with a scroll timeline in CSS: Chrome and Safari
// left the top fade on at the very top, and Firefox has no scroll timelines.
export function fades(list: HTMLElement): () => void {
  function update(): void {
    const row = (list.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    list.classList.toggle('scrolls', list.scrollHeight > list.clientHeight);
    // A list that rises from the bottom starts scrolled to its bottom, with
    // scrollTop at 0 and going negative as it scrolls up.
    const rises = getComputedStyle(list).flexDirection === 'column-reverse';
    const range = list.scrollHeight - list.clientHeight;
    const above = rises ? range + list.scrollTop : list.scrollTop;
    const below = range - above;
    list.style.setProperty('--fade-top', `${Math.max(0, Math.min(above, row))}px`);
    list.style.setProperty('--fade-bottom', `${Math.max(0, Math.min(below, row))}px`);
  }

  update();
  const resized = new ResizeObserver(update);
  resized.observe(list);
  list.addEventListener('scroll', update, { passive: true });
  return () => {
    resized.disconnect();
    list.removeEventListener('scroll', update);
  };
}
