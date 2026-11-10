// Popups close the same way they open: animated. Safari drops a closing
// popover from the page at once, whatever its CSS asks for, so a popup stays
// open marked "closing" while it animates and only then really closes.
// Because of that the popups are manual and the usual ways out are done here:
// pressing its name or the X, pressing anywhere outside, and Escape.

const timers = new WeakMap<HTMLElement, number>();

const openPopups = () => [...document.querySelectorAll<HTMLElement>('[popover]')].filter((popup) => popup.matches(':popover-open:not(.closing)'));

const openTime = (popup: HTMLElement) => parseFloat(getComputedStyle(popup).getPropertyValue('--open-time')) * 1000;

function close(popup: HTMLElement): void {
  popup.classList.add('closing');
  timers.set(
    popup,
    window.setTimeout(() => {
      popup.classList.remove('closing');
      popup.hidePopover();
    }, openTime(popup)),
  );
}

// The button is the popup's source, so focus goes back to it on closing.
function open(popup: HTMLElement, button: HTMLButtonElement): void {
  clearTimeout(timers.get(popup));
  for (const other of openPopups()) if (other !== popup) close(other);
  if (popup.classList.contains('closing')) popup.classList.remove('closing'); // turns back mid-way
  else popup.showPopover({ source: button } as ShowPopoverOptions);
}

document.addEventListener('click', (event) => {
  const target = event.target as Element;
  const button = target.closest<HTMLButtonElement>('button[popovertarget]');
  if (button) {
    event.preventDefault();
    const popup = document.getElementById(button.getAttribute('popovertarget')!)!;
    const shown = popup.matches(':popover-open:not(.closing)');
    if (shown) close(popup);
    else if (button.getAttribute('popovertargetaction') !== 'hide') open(popup, button);
    return;
  }
  for (const popup of openPopups()) if (!popup.contains(target)) close(popup);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const last = openPopups().at(-1);
  if (!last) return;
  event.preventDefault();
  close(last);
});
