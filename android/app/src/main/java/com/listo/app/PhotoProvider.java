package com.listo.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/**
 * Serves photos for the loyalty-card scanner's <input type=file>.
 *
 * androidx FileProvider is deliberately avoided (this app has zero
 * dependencies — see build.gradle), so this provider does the same job
 * for exactly one directory: <cache>/photos/. Declared with
 * grantUriPermissions, the camera app gets a one-shot write grant on
 * the URI handed to it via EXTRA_OUTPUT; the WebView then reads the
 * same content:// URI back for the file input result.
 *
 * Only the last path segment is used, so no traversal outside the
 * photos dir is possible.
 */
public class PhotoProvider extends ContentProvider {

    public static Uri uriFor(String name) {
        return new Uri.Builder().scheme("content")
                .authority("com.listo.app.photo").path(name).build();
    }

    private File dir() {
        File d = new File(getContext().getCacheDir(), "photos");
        d.mkdirs();
        return d;
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode)
            throws FileNotFoundException {
        File f = new File(dir(), uri.getLastPathSegment());
        int m = mode.contains("w")
                ? ParcelFileDescriptor.MODE_CREATE
                        | ParcelFileDescriptor.MODE_TRUNCATE
                        | ParcelFileDescriptor.MODE_READ_WRITE
                : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(f, m);
    }

    /** Minimal DISPLAY_NAME/SIZE answer — some WebView/file-input paths
        query the URI before reading it. */
    @Override
    public Cursor query(Uri uri, String[] projection, String sel,
                        String[] args, String order) {
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        File f = new File(dir(), uri.getLastPathSegment());
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        MatrixCursor c = new MatrixCursor(cols);
        c.addRow(row);
        return c;
    }

    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
}
