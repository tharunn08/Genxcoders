RetailMind Demo Data Package

This package was created ONLY from the uploaded source files.

Files:
01_products_200.xlsx
- 200 real product records from products(2).json.
- Includes SKU, product name, category, sub-category, MRP and image URL.

02_inventory_200.xlsx
- 200 real inventory records from the uploaded store stock report.
- Includes product, store, MRP, current stock, daily sales, stock status and mapped image URL where available.

03_sales_history_200.xlsx
- 200 real daily store sales records from IN93 DSR 2024-25.xlsx.
- This source is store-level daily sales data, NOT SKU-level sales. Therefore no fake SKU-level sales were created.

04_stock_receiving_200.xlsx
- 200 real warehouse/dispatch line records from the uploaded warehouse dispatch file.

05_stores_available.xlsx
- Store records actually available in the uploaded source data.

No fake suppliers, orders, transfers, or extra stores were invented because those datasets were not present in the uploaded files.

Important:
Before importing, check the exact column names required by the latest website importer. Rename columns only if the website specifically requires different headers.
