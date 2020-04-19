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

package com.app.playhvz.screens.gamesettings

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doOnTextChanged
import androidx.emoji.widget.EmojiEditText
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import androidx.navigation.fragment.findNavController
import androidx.navigation.fragment.navArgs
import com.app.playhvz.R
import com.app.playhvz.app.EspressoIdlingResource
import com.app.playhvz.app.debug.DebugFlags
import com.app.playhvz.common.ConfirmationDialog
import com.app.playhvz.firebase.classmodels.Game
import com.app.playhvz.firebase.operations.GameDatabaseOperations
import com.app.playhvz.firebase.viewmodels.GameViewModel
import com.app.playhvz.navigation.NavigationUtil
import com.app.playhvz.screens.gamelist.JoinGameDialog
import com.app.playhvz.utils.SystemUtils
import com.google.android.gms.tasks.OnSuccessListener
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.runBlocking


/** Fragment for showing a list of Games the user is registered for.*/
class GameSettingsFragment : Fragment() {
    companion object {
        private val TAG = GameSettingsFragment::class.qualifiedName
    }

    lateinit var firestoreViewModel: GameViewModel
    val args: GameSettingsFragmentArgs by navArgs()

    var gameId: String? = null
    var game: Game? = null

    private lateinit var nameView: EmojiEditText
    private lateinit var submitButton: Button
    private lateinit var gameNameErrorLabel: TextView
    private lateinit var progressBar: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        gameId = args.gameId
        firestoreViewModel = ViewModelProvider(this).get(GameViewModel::class.java)
        setupObservers()
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val view = inflater.inflate(R.layout.fragment_game_settings, container, false)
        nameView = view.findViewById(R.id.game_name)
        submitButton = view.findViewById(R.id.submit_button)
        gameNameErrorLabel = view.findViewById(R.id.game_name_error_label)
        progressBar = view.findViewById(R.id.progress_bar)

        submitButton.setOnClickListener { _ ->
            if (gameId == null) {
                createGame()
            } else {
                updateGame()
            }
        }

        if (DebugFlags.isDevEnvironment && gameId != null) {
            val deleteButton = view.findViewById<MaterialButton>(R.id.delete_button)
            deleteButton.icon = resources.getDrawable(R.drawable.ic_debug)
            deleteButton.visibility = View.VISIBLE
            deleteButton.setOnClickListener { showDeleteDialog() }
        }

        setupToolbar()
        initializeFields()
        return view
    }

    fun setupToolbar() {
        val toolbar = (activity as AppCompatActivity).supportActionBar
        if (toolbar != null) {
            toolbar.title =
                if (game == null || game?.name.isNullOrEmpty()) context!!.getString(R.string.game_settings_create_game_toolbar_title)
                else game?.name
            toolbar.setDisplayHomeAsUpEnabled(false)
        }
    }

    fun initializeFields() {
        if (gameId != null) {
            // Disable changing name of already created game
            nameView.setText(game?.name)
            nameView.isEnabled = false
            nameView.isFocusable = false
        } else {
            // Setup UI for creating a new game
            nameView.doOnTextChanged { text, _, _, _ ->
                when {
                    text.isNullOrEmpty() -> {
                        submitButton.isEnabled = false
                    }
                    text.contains(Regex("\\s")) -> {
                        submitButton.isEnabled = false
                        gameNameErrorLabel.setText(R.string.error_whitespace)
                        gameNameErrorLabel.visibility = View.VISIBLE
                        return@doOnTextChanged
                    }
                    else -> {
                        submitButton.setEnabled(true)
                    }
                }
                gameNameErrorLabel.visibility = View.GONE
            }
        }
    }

    private fun createGame() {
        val name = nameView.text
        val gameCreatedListener = OnSuccessListener<String> { gameId ->
            SystemUtils.showToast(context, getString(R.string.create_game_success_toast, name))
            NavigationUtil.navigateToGameList(findNavController(), activity!!)
            haveAdminCreatePlayer(gameId, name.toString())
        }
        val gameExistsListener = {
            SystemUtils.showToast(context, "$name already exists!")
            progressBar.visibility = View.INVISIBLE
            gameNameErrorLabel.setText(resources.getString(R.string.create_game_error_exists, name))
            gameNameErrorLabel.visibility = View.VISIBLE
        }
        runBlocking {
            EspressoIdlingResource.increment()
            progressBar.visibility = View.VISIBLE
            GameDatabaseOperations.asyncTryToCreateGame(
                name.toString(),
                gameCreatedListener,
                gameExistsListener
            )
            EspressoIdlingResource.decrement()
        }
    }

    private fun updateGame() {

    }

    private fun setupObservers() {
        if (gameId == null) {
            return
        }
        firestoreViewModel.getGame(gameId!!) {
            NavigationUtil.navigateToGameList(
                findNavController(),
                activity!!
            )
        }.observe(this, androidx.lifecycle.Observer { serverGame ->
            updateGame(serverGame)
        })
    }

    private fun updateGame(serverGame: Game?) {
        game = serverGame
        setupToolbar()
        initializeFields()
    }

    private fun showDeleteDialog() {
        val deleteDialog = ConfirmationDialog(
            getString(R.string.game_settings_delete_dialog_title, game?.name),
            R.string.game_settings_delete_dialog_description,
            R.string.game_settings_delete_dialog_confirmation,
            R.string.game_settings_delete_dialog_cancel
        )
        deleteDialog.setPositiveButtonCallback {
            if (gameId != null) {
                runBlocking {
                    EspressoIdlingResource.increment()
                    GameDatabaseOperations.asyncDeleteGame(
                        gameId!!
                    ) {
                        SystemUtils.showToast(context, "Deleted game")
                        SystemUtils.clearSharedPrefs(activity!!)
                        NavigationUtil.navigateToGameList(findNavController(), activity!!)
                    }
                    EspressoIdlingResource.decrement()
                }
            }
        }
        activity?.supportFragmentManager?.let { deleteDialog.show(it, TAG) }
    }

    private fun haveAdminCreatePlayer(gameId: String, gameName: String) {
        val joinGameDialog = JoinGameDialog(this)
        joinGameDialog.setGameName(gameName)
        activity?.supportFragmentManager?.let { joinGameDialog.show(it, TAG) }
    }
}