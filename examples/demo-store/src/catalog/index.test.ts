import { describe, expect, test } from "bun:test";
import { CatalogError, createCatalog, describeProduct, findProduct } from "./index";

const validProducts = [
  { id: "sku-1", name: "Keyboard", priceCents: 4900, stock: 3 },
  { id: "sku-2", name: "Mouse", priceCents: 1900, stock: 10 },
];

describe("M-CATALOG createCatalog", () => {
  test("accepts valid products", () => {
    const catalog = createCatalog(validProducts);
    expect(catalog.products).toHaveLength(2);
    expect(findProduct(catalog, "sku-1").name).toBe("Keyboard");
  });

  test("rejects duplicate ids", () => {
    expect(() => createCatalog([validProducts[0]!, validProducts[0]!])).toThrow("duplicate product id");
  });

  test("rejects non-positive prices and negative stock", () => {
    expect(() => createCatalog([{ id: "x", name: "Free", priceCents: 0, stock: 1 }])).toThrow(CatalogError);
    expect(() => createCatalog([{ id: "y", name: "Broken", priceCents: 100, stock: -1 }])).toThrow(CatalogError);
  });
});

describe("M-CATALOG findProduct / describeProduct", () => {
  test("throws for unknown product ids", () => {
    const catalog = createCatalog(validProducts);
    expect(() => findProduct(catalog, "missing")).toThrow("unknown product: missing");
  });

  test("formats the price through the money module", () => {
    const catalog = createCatalog(validProducts);
    expect(describeProduct(findProduct(catalog, "sku-1"))).toBe("Keyboard (49.00)");
  });
});
