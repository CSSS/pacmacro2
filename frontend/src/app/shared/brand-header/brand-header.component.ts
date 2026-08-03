import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'pac-brand-header',
  templateUrl: './brand-header.component.html',
  styleUrl: './brand-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandHeaderComponent {}
