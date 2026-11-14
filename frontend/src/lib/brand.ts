import { DEFAULT_BRAND, type Brand, type BrandColor } from "./types";

const COLORS: BrandColor[] = ["indigo", "emerald", "amber", "rose", "cyan", "violet"];

export function brandOf(domain: Partial<Brand> | undefined): Brand {
  const color = domain?.primary_color;
  return {
    brand_name: domain?.brand_name || DEFAULT_BRAND.brand_name,
    brand_tagline: domain?.brand_tagline || DEFAULT_BRAND.brand_tagline,
    primary_color: color && COLORS.includes(color) ? color : DEFAULT_BRAND.primary_color,
  };
}
