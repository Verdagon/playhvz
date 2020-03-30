/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.app.playhvz.utils

import java.text.SimpleDateFormat
import java.util.*

/** Util for common time formatting functions. */
class TimeUtils {

    companion object {
        private val TAG = TimeUtils::class.qualifiedName

        /** Returns the timestamp as a formatted string. */
        fun getFormattedTime(timestamp: Long, singleLine: Boolean): String {
            var pattern = "MMM dd, YYYY\nh:mm  a"
            if (singleLine) {
                pattern = "MMM dd\nh:mm  a"
            }
            val dateTimeFormatter = SimpleDateFormat(pattern, Locale.getDefault())
            return dateTimeFormatter.format(timestamp)
        }
    }
}