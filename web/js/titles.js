// Shortens titles that don't fit on one line. It keeps the start and the end
// of a title and drops whole words from around the golden ratio point.

const GOLDEN_RATIO = 0.618
const ELLIPSIS = ' … '

const canvas = document.createElement('canvas').getContext('2d')
const fitted = new WeakMap() // link -> { title, width }
let lineWidth = 0

function textWidth(text) {
  return canvas.measureText(text).width
}

// Decides how many parts to keep from the start and from the end.
function partsToKeep(parts, joiner, room) {
  const startWidth = (count) => textWidth(parts.slice(0, count).join(joiner))
  const endWidth = (count) => textWidth(parts.slice(parts.length - count).join(joiner))
  const fits = (start, end) => start + end < parts.length && startWidth(start) + endWidth(end) <= room
  const target = room * GOLDEN_RATIO

  let start = 0
  let end = 0

  // Take words from the start up to the golden point...
  while (fits(start + 1, 0) && startWidth(start + 1) <= target) start++

  // ...and one more if that lands closer to it.
  if (fits(start + 1, 0) && startWidth(start + 1) - target < target - startWidth(start)) start++

  // Fill the rest from the end, then give any leftover room back to the start.
  while (fits(start, end + 1)) end++
  while (fits(start + 1, end)) start++

  return [start, end]
}

function shorten(title, room) {
  const space = room - textWidth(ELLIPSIS)
  const words = title.split(' ').filter((word) => word !== '…')
  const [start, end] = partsToKeep(words, ' ', space)

  if (start > 0 || end > 0) {
    const head = words.slice(0, start).join(' ').replace(/[,;:–—-]+$/, '')
    const tail = words.slice(words.length - end).join(' ')
    return `${head}${ELLIPSIS}${tail}`.trim()
  }

  // No whole word fits, so this is something like a long URL or file name.
  // Cut it after dashes, underscores and other punctuation, or before # ? & @.
  // Only cut between letters if those are too far apart.
  const pieces = title.split(/(?<=[/\\\-–—_.,:;+=~|])|(?=[#?&@])/)
  const letters = Array.from(new Intl.Segmenter().segment(title), (part) => part.segment)

  for (const parts of [pieces, letters]) {
    const [start, end] = partsToKeep(parts, '', space)
    if (start > 0 && end > 0) {
      return `${parts.slice(0, start).join('')}${ELLIPSIS}${parts.slice(parts.length - end).join('')}`
    }
  }

  return title
}

function fitTitle(link) {
  const known = fitted.get(link)
  if (known?.width === lineWidth) return

  const title = known?.title ?? link.textContent
  const room = lineWidth - 1
  const shown = textWidth(title) > room ? shorten(title, room) : title

  fitted.set(link, { title, width: lineWidth })
  if (link.textContent !== shown) link.textContent = shown

  if (shown === title) link.removeAttribute('aria-label')
  else link.setAttribute('aria-label', title)
}

function fitTitles() {
  const list = document.getElementById('list')
  if (!list) return

  if (!lineWidth) {
    const style = getComputedStyle(list)
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    lineWidth = list.clientWidth
  }

  for (const link of list.querySelectorAll('a.title')) {
    // The browser hasn't finished reading a title until the next element exists.
    if (link.nextElementSibling) fitTitle(link)
  }
}

// Runs as rows are parsed or swapped in, before they are painted.
new MutationObserver(fitTitles).observe(document, { childList: true, subtree: true })

addEventListener('resize', () => {
  lineWidth = 0
  fitTitles()
})
