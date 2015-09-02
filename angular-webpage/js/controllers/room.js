function RoomCtrl($scope, $location, $window, $params, socket, constraints, notifications, progress, participants) {

	if (participants.isEmpty())
		$location.path('/');

	socket.roomReady();

	$scope.roomName = $params.roomName;

	$scope.lineExtension = '';

	$scope.presentation = {
		active: false,
		presenterIsMe: false,
		disabled: {
			all: function() {
				this.general = true;
				this.screen = true;
				this.window = true;
				_.defer(function() {
					$scope.$apply();
				});
			},
			general: false,
			screen: false,
			window: false,
			none: function() {
				this.general = false;
				this.screen = false;
				this.window = false;
				_.defer(function() {
					$scope.$apply();
				});
			}
		}
	};

	$scope.participantNames = [];

	socket.get().onmessage = function(message) {

		var parsedMessage = JSON.parse(message.data);
		console.info('Received message: ' + message.data);

		switch (parsedMessage.id) {

			case 'compositeInfo':
				sendStream(parsedMessage, 'composite');
				break;

			case 'presentationInfo':
				if (constraints.browserIsFirefox)
					sendStream(parsedMessage, 'presentation');
				break;

			case 'presenterReady':
				onPresenterReady(parsedMessage);
				break;

			case 'cancelPresentation':
				cancelPresentation(parsedMessage);
				break;
			
			case 'newParticipantArrived':
				onNewParticipant(parsedMessage);
				break;
			
			case 'participantLeft':
				onParticipantLeft(parsedMessage);
				break;
			
			case 'receiveVideoAnswer':
				receiveVideoResponse(parsedMessage);
				break;
			
			case 'existingPresentation':
				
				var warning = {
					title: 'Someone is currently presenting',
					content: 'You cannot present until the current presentation has finished.'
				};

				notifications.alert(warning.title, warning.content, 'Ok', function(answer) {
					// This should be handled by lumx (it must be a bug)
					// May be removed in the future
					$('.dialog-filter').remove();
					$('.dialog').remove();
				});

				$scope.stopPresenting();
				break;
			
			case 'existingName':

				constraints.setWarning(true);
				$scope.leave();

				break;
			
			case 'iceCandidate':

				participants.get(parsedMessage.userId).rtcPeer[parsedMessage.type].addIceCandidate(parsedMessage.candidate, function(error) {
					if (error) {
						console.error("Error adding candidate: " + error);
						return;
					}
				});

				break;

			case 'lineAvailable':
				setLineExtension(parsedMessage.extension);
				break;

			default:
				console.error('Unrecognized message', parsedMessage);
		}
	};

	// Configuration for the extension if it is Chrome
	if (constraints.browserIsChrome) {
		$window.addEventListener('message', function(event) {

			// user chose a stream
			if (event.data.type && (event.data.type === 'SS_DIALOG_SUCCESS')) {
				constraints.setId(event.data.streamId);
				sendStream({}, 'presentation');
			}

			// user clicked on 'cancel' in choose media dialog
			if (event.data.type && (event.data.type === 'SS_DIALOG_CANCEL')) {
				$scope.stopPresenting();
			}
		});
	}

	$scope.stopPresenting = function() {

		var participant = participants.me();

		if (participant !== undefined && participant.rtcPeer['presentation'] !== null) {
			participant.rtcPeer['presentation'].dispose();
			participant.rtcPeer['presentation'] = null;
		}

		$scope.presentation.presenterIsMe = false;
		constraints.setType('composite');
		socket.send({ id: 'stopPresenting' });
	};

	$scope.share = function(type) {

		var currentType = constraints.getType();
		var success = true;

		// if there is already a presenter who is not me
		if ($scope.presentation.active && !$scope.presentation.presenterIsMe)
			return;

		// on Chrome, the extension handles window or screen
		if ((type != currentType || constraints.browserIsChrome) && constraints.canPresent) {

			if (currentType != 'composite')
				this.stopPresenting();

			if (constraints.browserIsChrome) {
			
				if (!constraints.isChromeExtensionInstalled()) {
					var warning = {
						title: 'Chrome extension needed',
						content: 'To enable screensharing or window sharing, please use our extension.'
					};
					
					notifications.confirm(warning.title, warning.content, { cancel: 'Cancel', ok: 'Download'}, function(answer) {
						if (answer === true)
							$window.location = '/extension.crx';
					});

					success = false;
					
				} else {
					$window.postMessage({ type: 'SS_UI_REQUEST', text: 'start' }, '*');
				}

			}

			if (success) {

				constraints.setType(type);
				$scope.presentation.presenterIsMe = true;

				socket.send({
					id: 'newPresenter',
					userId: participants.me().userId,
					room: this.roomName,
					mediaSource: type
				});

			}
		}
	};

	$scope.canPresent = function(browser) {
		
		return (constraints.canPresent && browser == constraints.browser);

	};

	$scope.invite = function(number) {
		socket.send({
			id: 'invite',
			callee: number
		});
	};

	$scope.leave = function() {
		socket.send({ id: 'leaveRoom' });
		constraints.setType('composite');
		participants.clear();
		$location.path('/');
	};

	$scope.$on('$destroy', function() {
		constraints.setType('composite');
		participants.clear();
	});

	function receiveVideo(sender, isScreensharer) {

		if (participants.get(sender) === undefined)
			participants.add(sender);

		if (isScreensharer) {
			progress.circular.show('#2196F3', '#progress');
			$scope.presentation.disabled.all();
		}

		var participant = participants.get(sender);
		
		var type = (!isScreensharer) ? 'composite' : 'presentation';

		var options = {
			remoteVideo: document.getElementById(type),
			onicecandidate: participant.onIceCandidate[type].bind(participant)
		};

		participant.rtcPeer[type] = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options,
			function(error) {
				if (error) {
					return console.error(error);
				}

				this.generateOffer(participant.offerToReceive[type].bind(participant));
			});
	}

	function sendStream(message, type) {

		var participant = participants.me();

		var options = {
			mediaConstraints: constraints.get(),
			onicecandidate: participant.onIceCandidate[type].bind(participant)
		};

		if (message.lineExtension)
			setLineExtension(message.lineExtension);

		if (type == 'composite') {
			$scope.participantNames = message.data;
			$scope.participantNames.push(participant.name);
			options.remoteVideo = document.getElementById(type);
		} else {
			options.localVideo = document.getElementById(type);
			$scope.presentation.disabled[constraints.getType()] = true;
		}

		participant.rtcPeer[type] = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options,
			function(error) {
				if (error)
					$scope.presentation.presenterIsMe = false;

				if (constraints.browserIsFirefox && error && type != 'composite') {

					var warning = {
						title: 'Firefox needs to be configured (about:config)',
						content: 'Set media.getusermedia.screensharing.enabled to true and add our address to media.getusermedia.screensharing.allowed_domains'
					};

					notifications.alert(warning.title, warning.content, 'Ok', function(answer) {
						// This should be handled by lumx (it must be a bug)
						// May be removed in the future
						$('.dialog-filter').remove();
						$('.dialog').remove();
					});
				}

				this.generateOffer(participant.offerToReceive[type].bind(participant));
			});

		if (message.existingScreensharer && type == 'composite') {
			enablePresentationClass();

			if (message.screensharer != participants.me().userId)
				receiveVideo(message.screensharer, true);
		}

	}

	function onPresenterReady(message) {

		enablePresentationClass();

		if (message.presenter != participants.me().userId) {
			receiveVideo(message.presenter, true);
		}
	}

	function cancelPresentation(message) {

		console.log("Cancelling Presentation");

		disablePresentationClass();

		if (message.presenter != participants.me().userId) {
			if (participants.get(message.presenter) !== undefined)
				participants.get(message.presenter).rtcPeer['presentation'].dispose();
		}
	}

	function onNewParticipant(request) {

		participants.add(request.userId, request.name);
		$scope.participantNames.push(request.name);

		notifications.notify(request.name + ' has joined the room', 'account-plus');

		console.log(request.name + " has just arrived");

	}

	function onParticipantLeft(request) {

		console.log('Participant ' + request.name + ' left');
		var participant = participants.get(request.userId);

		if (request.isScreensharer) {
			disablePresentationClass();

			if (participant !== undefined)
				participant.dispose();
		}

		participants.remove(request.userId);

		notifications.notify(request.name + ' has left the room', 'account-remove');

		$scope.participantNames = request.data;
	}

	function receiveVideoResponse(result) {
		
		participants.get(result.userId).rtcPeer[result.type].processAnswer(result.sdpAnswer, function(error) {
			if (error) return console.error(error);
		});
	}

	function setLineExtension(extension) {
		$scope.lineExtension = (extension === '') ? extension : '(' + extension + ')';
		_.defer(function() {
			$scope.$apply();
		});
	}

	// CSS part
	angular.element(document).ready(function () {
		adaptCompositeContainer();

		$(window).resize(function() {
			adaptCompositeContainer();
		});

		$('video').resize(function() {
			adaptCompositeContainer();
		}).on('play', function() {
			$(this).addClass('playing');
		});

		$('#presentation').on('play', function() {
			$(this).addClass('playing');
			progress.circular.hide();
		});
	});

	function adaptCompositeContainer() {
		$('video').css('max-height', $(window).height() - 90 + 'px');
	}

	function enablePresentationClass() {
		$scope.presentation.active = true;
		setWidth('.video-room', null, 'hasPresentation', ['noPresentation']);
	}

	function disablePresentationClass() {
		setWidth('.video-room', null, 'noPresentation', ['hasPresentation', 'bigger', 'smaller']);
		$('#presentation').removeClass('playing');
		$scope.presentation.active = false;
		$scope.presentation.disabled.none();
	}

	function setWidth(elt1, elt2, elt1Class, elt2Classes) {
		if ($scope.presentation.active) {
			$(elt1).animate({
				opacity: 1
			}, {
				duration: 500,
				start: function() {
					for (var k in elt2Classes) {
						$(elt1).removeClass(elt2Classes[k]);
					}

					$(elt1).addClass(elt1Class);
				},
				progress: adaptCompositeContainer
			});

			$(elt2).removeClass(elt1Class);

			for (var k in elt2Classes)
				$(elt2).addClass(elt2Classes[k]);
		}
	}

	var compositeSizeBig = false;
	var presentationSizeBig = false;

	function setBigs(isCompositeBig, isPresentationBig) {
		compositeSizeBig = isCompositeBig;
		presentationSizeBig = isPresentationBig;
	}

	$scope.changeCompositeSize = function() {
		if (!compositeSizeBig) {
			setWidth('#composite-container', '#presentation-container', 'bigger', ['smaller']);
			setBigs(true, false);
		} else {
			setWidth('#composite-container', null, null, ['bigger']);
			setWidth('#presentation-container', null, null, ['smaller']);
			setBigs(false, false);
		}
	};

	$scope.changePresentationSize = function() {
		if (!presentationSizeBig) {
			setWidth('#composite-container', '#presentation-container', 'smaller', ['bigger']);
			setBigs(false, true);
		}  else {
			setWidth('#presentation-container', null, null, ['bigger']);
			setWidth('#composite-container', null, null, ['smaller']);
			setBigs(false, false);
		}
	};

	// Volume part
	$scope.volume = {
		muted: false,
		icon: 'mdi-volume-high',
		change: function() {
			this.muted = !this.muted;
			this.icon = (this.muted) ? 'mdi-volume-off' : 'mdi-volume-high';
			$('#composite').prop('muted', this.muted);
		}
	};
}
