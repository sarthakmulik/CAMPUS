const fs = require('fs')
const css = fs.readFileSync('src/styles.css', 'utf8')
const classes = new Set()
const ids = new Set()
for (const chunk of css.split('}')) {
  const brace = chunk.lastIndexOf('{')
  const selectorPart = brace === -1 ? chunk : chunk.slice(0, brace)
  for (const piece of selectorPart.split(',')) {
    for (const cls of piece.match(/\.[a-zA-Z0-9_-]+/g) || []) classes.add(cls)
    for (const id of piece.match(/#[a-zA-Z0-9_-]+/g) || []) {
      if (!/^#[0-9a-fA-F]{3,8}$/.test(id)) ids.add(id)
    }
  }
}
const wanted = process.argv.slice(2)
const sorted = [...classes].sort()
if (wanted.length) {
  for (const w of wanted) {
    const hits = sorted.filter(c => c.includes(w))
    console.log(`${w}: ${hits.length ? hits.join(' ') : 'MISSING'}`)
  }
} else {
  console.log(sorted.join('\n'))
}
