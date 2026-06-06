#!/usr/bin/env node
// Generate parkrun milestone badge SVGs matching official t-shirt colours
const fs = require('fs');
const path = require('path');

const badges = [
  { num: 10,   color: '#FFFFFF', textColor: '#333333', label: 'Jr 10', bgStroke: '#ccc' },
  { num: 25,   color: '#7B2D8E', textColor: '#FFFFFF', label: '25' },
  { num: 50,   color: '#E31937', textColor: '#FFFFFF', label: '50' },
  { num: 100,  color: '#1C1C1C', textColor: '#FFFFFF', label: '100' },
  { num: 250,  color: '#00843D', textColor: '#FFFFFF', label: '250' },
  { num: 500,  color: '#003DA5', textColor: '#FFFFFF', label: '500' },
  { num: 1000, color: '#FFD700', textColor: '#1C1C1C', label: '1000' },
];

const dir = path.join(__dirname);

for (const b of badges) {
  const fontSize = b.label.length <= 2 ? 28 : b.label.length === 3 ? 22 : 18;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="30" fill="${b.color}" stroke="${b.bgStroke || b.color}" stroke-width="2"/>
  <circle cx="32" cy="32" r="26" fill="none" stroke="${b.textColor}" stroke-width="1.5" opacity="0.3"/>
  <text x="32" y="${fontSize > 20 ? 36 : 38}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fontSize}" fill="${b.textColor}">${b.label}</text>
  <text x="32" y="52" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="7" fill="${b.textColor}" opacity="0.7">CLUB</text>
</svg>`;

  const filename = `badge-${b.num}.svg`;
  fs.writeFileSync(path.join(dir, filename), svg);
  console.log(`✅ ${filename}`);
}

// Also create a volunteer badge
const volSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="30" fill="#FF6B35" stroke="#FF6B35" stroke-width="2"/>
  <circle cx="32" cy="32" r="26" fill="none" stroke="#FFFFFF" stroke-width="1.5" opacity="0.3"/>
  <text x="32" y="28" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#FFFFFF">🙌</text>
  <text x="32" y="46" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="9" fill="#FFFFFF">VOL</text>
</svg>`;
fs.writeFileSync(path.join(dir, 'badge-vol.svg'), volSvg);
console.log('✅ badge-vol.svg');
