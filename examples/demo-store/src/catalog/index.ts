// START_MODULE_CONTRACT
//   PURPOSE: Build a validated product catalog and resolve products by id.
//   SCOPE: createCatalog(), findProduct(), describeProduct(); throws CatalogError on invalid input.
//   DEPENDS: M-MONEY
//   LINKS: docs/modules/M-CATALOG.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   createCatalog   — validate and freeze a product list
//   findProduct     — resolve one product or throw CatalogError
//   describeProduct — human-readable name + formatted price
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — initial implementation with duplicate/price/stock validation
// END_CHANGE_SUMMARY

import { formatAmount } from "../money/index";

export interface Product {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

export interface Catalog {
  readonly products: readonly Product[];
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

// START_CONTRACT: createCatalog
//   PURPOSE: Validate a product list and return an immutable catalog.
//   INPUTS: products — product records supplied by the caller
//   OUTPUTS: Catalog
//   ERRORS: CatalogError for empty ids, duplicates, invalid prices or stock
// END_CONTRACT: createCatalog
export function createCatalog(products: readonly Product[]): Catalog {
  // START_BLOCK_VALIDATE_PRODUCTS
  const seen = new Set<string>();
  for (const product of products) {
    if (product.id.trim() === "") throw new CatalogError("product id is required");
    if (seen.has(product.id)) throw new CatalogError(`duplicate product id: ${product.id}`);
    if (!Number.isInteger(product.priceCents) || product.priceCents <= 0) {
      throw new CatalogError(`invalid price for ${product.id}`);
    }
    if (!Number.isInteger(product.stock) || product.stock < 0) {
      throw new CatalogError(`invalid stock for ${product.id}`);
    }
    seen.add(product.id);
  }
  // END_BLOCK_VALIDATE_PRODUCTS
  return { products: [...products] };
}

// START_CONTRACT: findProduct
//   PURPOSE: Resolve a product by id.
//   INPUTS: catalog — validated catalog; id — product id
//   OUTPUTS: Product
//   ERRORS: CatalogError when the id is unknown
// END_CONTRACT: findProduct
export function findProduct(catalog: Catalog, id: string): Product {
  // START_BLOCK_RESOLVE_PRODUCT
  const product = catalog.products.find((candidate) => candidate.id === id);
  if (product === undefined) throw new CatalogError(`unknown product: ${id}`);
  return product;
  // END_BLOCK_RESOLVE_PRODUCT
}

export function describeProduct(product: Product): string {
  return `${product.name} (${formatAmount(product.priceCents)})`;
}
