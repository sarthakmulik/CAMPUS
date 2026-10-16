const fs = require('fs')
const css = fs.readFileSync('src/styles.css', 'utf8')
const names = process.argv.slice(2)
for (const name of names) {
  const re = new RegExp('(^|[\\s,}])' + name.replace('.', '\\.') + '\\s*\\{[^}]*\\}', 'g')
  let m
  let found = false
  while ((m = re.exec(css))) {
    found = true
    console.log('>>>', m[0].trim())
  }
  if (!found) console.log('>>>', name, 'NOT FOUND')
}
