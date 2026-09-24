import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LogoMark } from './logo-mark';

@Component({
  selector: 'app-landing',
  imports: [RouterLink, LogoMark],
  template: `
    <header class="nav">
      <div class="page nav-inner">
        <a class="brand" routerLink="/"><app-logo-mark />savvyai</a>
        <a class="btn btn-secondary btn-nav" routerLink="/login">Open the workspace</a>
      </div>
    </header>

    <main class="page site">
      <h1 class="sr-only">savvyai is under construction</h1>

      <!-- A road sign in the savvyai palette: --mark face, --on-mark ink. Both are the same
           in either theme, so the sign does too. Drawn as paths, not rotated rects, so the
           face gradient runs top to bottom instead of along the diagonal. -->
      <svg class="sign" viewBox="0 0 400 400" aria-hidden="true">
        <defs>
          <linearGradient id="uc-face" gradientUnits="userSpaceOnUse" x1="0" y1="14" x2="0" y2="386">
            <stop offset="0" class="face-top" />
            <stop offset="1" class="face-bottom" />
          </linearGradient>
          <pattern id="uc-stripes" patternUnits="userSpaceOnUse" width="16" height="16"
                   patternTransform="rotate(40)">
            <rect class="ink" width="8" height="16" />
          </pattern>
          <mask id="uc-jaw" maskUnits="userSpaceOnUse" x="-40" y="-50" width="80" height="100">
            <rect x="-40" y="-50" width="80" height="100" fill="white" />
            <rect x="-5" y="-34" width="10" height="17" rx="1.5" fill="black" />
            <circle cy="27" r="2.6" fill="black" />
          </mask>
        </defs>

        <path class="face"
          d="M176 38Q200 14 224 38L362 176Q386 200 362 224L224 362Q200 386 176 362L38 224Q14 200 38 176Z" />
        <path class="rim"
          d="M186 54Q200 40 214 54L346 186Q360 200 346 214L214 346Q200 360 186 346L54 214Q40 200 54 186Z" />

        <g class="ink">
          <!-- hammer, head to the top left -->
          <g transform="translate(200 124) rotate(-45)">
            <rect x="-3.5" y="-12" width="7" height="44" rx="3.5" />
            <rect x="-5" y="-16" width="10" height="6" />
            <rect x="-17" y="-28" width="34" height="14" rx="3" />
          </g>
          <!-- wrench, head to the top right -->
          <g transform="translate(200 124) rotate(45)" mask="url(#uc-jaw)">
            <rect x="-4.5" y="-10" width="9" height="42" rx="4.5" />
            <circle cy="-17" r="13" />
          </g>
        </g>

        <text class="word" x="200" y="222" text-anchor="middle" font-size="52"
              textLength="200" lengthAdjust="spacingAndGlyphs">UNDER</text>
        <text class="word" x="200" y="254" text-anchor="middle" font-size="21"
              textLength="176" lengthAdjust="spacingAndGlyphs">CONSTRUCTION</text>

        <path fill="url(#uc-stripes)" d="M122 270H278L258 292H142Z" />
      </svg>
    </main>
  `,
  styles: `
    .site {
      min-block-size: calc(100dvh - var(--nav-h));
      display: grid; place-items: center; padding-block: var(--s-6);
    }

    .sign {
      inline-size: min(100%, 24rem); block-size: auto;
      filter: drop-shadow(0 18px 28px color-mix(in oklab, var(--on-mark) 24%, transparent));
      animation: arrive var(--t-open) var(--ease) backwards;
    }
    @keyframes arrive { from { opacity: 0; translate: 0 12px; } }

    .face { fill: url(#uc-face); }
    .face-top { stop-color: var(--mark); }
    .face-bottom { stop-color: color-mix(in oklab, var(--mark) 84%, var(--on-mark)); }
    .rim { fill: none; stroke: var(--on-mark); stroke-width: 9; stroke-linejoin: round; }
    .ink { fill: var(--on-mark); }
    .word { fill: var(--on-mark); font-family: var(--ff-text); font-weight: 800; }
  `,
})
export class Landing {}
