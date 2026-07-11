# 11. Importing and Exporting Data

## Export Options
NimbusImage provides flexible data export capabilities for external analysis, backup, or transferring annotations:

1. **CSV Format** for spreadsheet analysis in Excel, R, or Python
2. **TSV Format** (tab-separated values) as an alternative to CSV—recommended when property names contain commas. A format toggle in the export dialog lets you switch between CSV and TSV.
3. **JSON Format** for complete data backup or transfer between datasets

## Exporting as CSV
To export data in CSV format for statistical analysis:
1. Open the Annotation List
2. Click "ACTIONS" 
3. Select "Export CSV"
4. Configure options:
   - **Property Export Options**: All properties, listed properties, or specific properties
   - **Undefined Value Handling**: Empty string, NA, or NaN
5. Review column preview
6. Enter filename and click "DOWNLOAD"

The CSV file contains object identifiers, metadata, tags, attributes, and all selected property values.

## Exporting as JSON
For comprehensive data records, export in JSON format:
1. Open the Annotation List
2. Click "ACTIONS"
3. Select "Export JSON"
4. Choose inclusions:
   - Export annotations (objects)
   - Export annotation connections
   - Export properties
   - Export property values
5. Enter filename and click "EXPORT SELECTED ITEMS"

The JSON file contains complete geometric data, connection information, property definitions, and dataset metadata.

## Importing Annotations
JSON files can be imported to:
- Restore annotations from backups
- Transfer annotations between compatible datasets
- Share analysis with collaborators

To import:
1. Navigate to the target dataset
2. Click "ACTIONS" in the Annotation List
3. Select "Import JSON"
4. Select the JSON file
5. Review import options
6. Click "IMPORT"

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

