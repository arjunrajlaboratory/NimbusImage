# 13. Troubleshooting

## Performance Issues
Solutions for slow or unresponsive behavior:

**Browser Performance**:
- Refresh the page to clear memory
- Close unnecessary browser tabs
- Use Chrome for best compatibility (especially for SAM)
- Check browser console for errors (F12)

**Dataset Loading**:
- Large datasets undergo background optimization when first opened
- Performance improves after initial processing completes
- If consistently slow, consider cropping or downsampling large datasets
- Enable "Transcode into optimized TIFF file" during import for better performance

**Annotation Handling**:
- Large numbers of annotations (>100,000) can slow performance
- Use the tag picker to hide unnecessary annotations
- Filter object display to only what's needed
- Consider splitting very large datasets

**Server Status**:
- A sync indicator (a **database icon**) sits in the top bar; hover it for a status tooltip
  - **In sync** (database-check icon): your work is saved and up to date with the server
  - **Saving / Loading** (animated database icon): a change is being written, or data is loading
  - **Sync error** (red database-alert icon): a connection problem — hover to read the message
- Wait for background tasks to complete before making additional changes

## Data Import Problems
Resolving issues with loading data:

**File Format Issues**:
- Check supported format list in documentation
- For complex formats (OME-TIFF series), pre-process with `large_image_converter`
- For IncuCyte data, use the provided preprocessing script

**Variable Assignment**:
- If variables are incorrectly assigned (time vs. Z):
  - Use the Advanced Import option
  - Manually reassign variables in the interface
  - Check file naming conventions for automatic detection

**Import Failures**:
- Very large files may exceed system limits
- Try importing portions of the dataset
- Check for corrupted files by opening in other viewers
- Ensure sufficient storage space on the server

**Multi-File Datasets**:
- Files must have consistent naming patterns
- Z/T/channel information should be in filename or metadata
- Try both with and without the "Transcode into optimized TIFF file" option

## Analysis Accuracy
Improving results when analysis is incorrect:

**Segmentation Issues**:
- For Cellpose: Adjust diameter parameter to match cell size
- For Piscis: Try different models before adjusting thresholds
- For StarDist: Adjust probability threshold for sensitivity
- Consider retraining models on your specific data

**False Positives/Negatives**:
- Rather than endless parameter tweaking, use NimbusImage's strength:
  - Manually delete false positives
  - Add missing objects with manual tools
  - Both will be seamlessly included in analysis

**Measurement Problems**:
- Verify correct channel selection in property workers
- Check object tags match what you intend to measure
- For intensity measurements, ensure proper background correction
- For counts, verify Z-slice settings match your intent

**Connection Errors**:
- Adjust maximum distance parameters
- Review connection directionality (parent/child)
- For time lapse, check gap handling settings
- Manually fix critical connections with connection tools

## Common Error Messages

**"Worker failed"**:
- View the job's error log: in the Settings panel, under **Jobs & Logs**, click **Show jobs and logs**, then click **Log** on that job's row in the Recent Jobs dialog
- Common causes:
  - Parameter out of range
  - Memory limits exceeded
  - Server resource constraints
- Try with smaller batch or adjusted parameters

**"Unable to load file"**:
- File format may be incompatible
- File might be corrupted
- Permissions issue on server
- Try different import settings or file conversion

**"Connection lost"**:
- Server connection interrupted
- Refresh page and check internet connection
- Login session may have expired

**"Invalid parameter"**:
- Check parameter ranges in documentation
- Ensure no special characters in text fields
- Range notation should follow format "1-5" or "1-3, 7-9"

## Recovering Work

**Auto-Saving Behavior**:
- NimbusImage automatically saves annotations when drawn
- No manual "save" required
- Like Google Docs, changes commit to server immediately

**Handling Desynchronization**:
- If the database icon turns red (a sync error), a connection issue was detected
- Refresh page before continuing work
- Check annotations after refresh to verify they were saved

**Backing Up Analysis**:
- Regularly export to JSON as backup
- Export CSV for analysis results
- Create snapshots to document important views
- Download snapshot images for visual record

**Recovering from Crashes**:
- Refresh the page and check if annotations persist
- If annotations missing, check if JSON backup exists
- Contact support if substantial work is lost

**Prevention**:
- For complex analyses, work in stages with exports between
- Use meaningful tags to facilitate recovery
- Document workflow steps for reproducibility

For persistent issues not resolved by these steps, contact support@cytopixel.com with detailed information about the problem, including browser type, actions that led to the issue, and any error messages.
