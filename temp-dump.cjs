const fs = require('fs');
for (const f of ['src/styles.onboarding.css', 'src/styles.ui4.css', 'src/styles.css']) {
  const src = fs.readFileSync(f, 'utf8');
  const m = src.match(/\.(community-tabs|mk-tabs|mcl-tabs)[^{,]*\{[^}]*\}/g);
  if (m) console.log(`== ${f} ==\n` + m.join('\n----\n'));
}
