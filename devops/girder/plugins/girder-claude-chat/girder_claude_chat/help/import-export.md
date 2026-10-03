# 11. Importing and Exporting Data

## Export Options
NimbusImage provides flexible data export capabilities for external analysis, backup, or transferring annotations:

1. **CSV Format** for spreadsheet analysis in Excel, R, or Python
2. **TSV Format** (tab-separated values) as an alternative to CSV—recommended when property names contain commas. A format toggle in the export dialog lets you switch between CSV and TSV.
3. **JSON Format** for complete data backup or transfer between datasets

## Exporting as CSV
To export data in CSV format for statistical analysis:
1. Click the **Import / export data** icon in the top app bar (the up/down-arrows icon)
2. Choose **Export CSV**
3. Configure options:
   - **Property Export Options**: All properties, listed properties, or specific properties
   - **Undefined Value Handling**: Empty string, NA, or NaN
   - **File format**: CSV or TSV (CSV by default; choose TSV when property names contain commas)
4. Review the column preview
5. Enter a filename and click **Download**

The CSV file contains object identifiers, metadata, tags, attributes, and all selected property values.

## Exporting as JSON
For comprehensive data records, export in JSON format:
1. Click the **Import / export data** icon in the top app bar
2. Choose **Export to JSON**
3. Choose inclusions:
   - Export annotations (objects)
   - Export annotation connections
   - Export properties
   - Export property values
4. Enter a filename and click **Export** (the button reads "Export N datasets" when exporting a whole collection)

The JSON file contains complete geometric data, connection information, property definitions, and dataset metadata.

## Importing Annotations
JSON files can be imported to:
- Restore annotations from backups
- Transfer annotations between compatible datasets
- Share analysis with collaborators

To import:
1. Navigate to the target dataset
2. Click the **Import / export data** icon in the top app bar
3. Choose **Import from JSON**
4. Select the JSON file
5. Review the import options
6. Click **Import selection**

Compatible dataset structures are essential for successful imports. Importing will not overwrite existing annotations unless explicitly configured.

## Data Ownership and Integration
NimbusImage's export capabilities ensure:
- Complete ownership of analysis data
- Advanced analysis in preferred external tools
- Comprehensive work backups
- Transparent sharing with collaborators
- Integration with broader workflows
- Creation of reproducible analysis pipelines

This combination of interactive analysis and flexible data export provides a powerful workflow that maintains scientific integrity and ease of use.

